const config = require('config');
const log = require('../lib/log');
const fluxApi = require('./fluxApi');
const dnsGateway = require('./dnsGateway');
const specDecryptor = require('./specDecryptor');
const appResolver = require('./appResolver');
const recordPlanner = require('./recordPlanner');

// DNS state tracking to prevent unnecessary updates
// Tracks current DNS state per app - persists until service restart
// Memory bounded by active app count (~10-50 apps)
const appsDNSState = new Map();

// Track when each app was last seen (for deletion grace period)
// Map<appName, timestamp> - only starts tracking when app disappears
const appLastSeenTimestamps = new Map();

// Polling state
let isRunning = false;
let pollingInterval = null;

/**
 * Check if IPs for an app have changed since last DNS update
 * @param {string} appName - Application name
 * @param {string[]} currentIPs - Current IP addresses
 * @param {string} zone - DNS zone
 * @returns {boolean} True if IPs have changed or no state entry exists
 */
function hasIPsChanged(appName, currentIPs, zone) {
  const appState = appsDNSState.get(appName);
  if (!appState) return true;

  const cachedState = appState.get(zone);
  if (!cachedState) return true;

  // Compare IP arrays (order-independent)
  const cachedIPsSet = new Set(cachedState);
  const currentIPsSet = new Set(currentIPs);

  if (cachedIPsSet.size !== currentIPsSet.size) return true;

  for (const ip of currentIPsSet) {
    if (!cachedIPsSet.has(ip)) return true;
  }

  return false;
}

/**
 * Update DNS state after successful DNS record operation
 * @param {string} appName - Application name
 * @param {string[]} ips - IP addresses that were set
 * @param {string} zone - DNS zone
 */
function updateDNSState(appName, ips, zone) {
  let appState = appsDNSState.get(appName);
  if (!appState) {
    appState = new Map();
    appsDNSState.set(appName, appState);
  }
  appState.set(zone, [...ips]);
}

/**
 * Gather what the platform currently believes about where an app is, fetching only
 * what the app's strategy actually consumes: a single-answer app needs to know
 * which instance was elected, a multi-answer one needs every placement.
 *
 * @param {Object} selection
 * @param {Object} zone
 * @returns {Promise<{ elected: (string|null), placed: string[] }>}
 */
async function resolveState(selection, zone) {
  if (selection.strategy === 'roundRobin') {
    const locations = await fluxApi.getApplicationLocation(selection.appName);
    return { elected: null, placed: locations.map((entry) => entry.ip).filter(Boolean) };
  }
  const elected = await fluxApi.getAppMasterIpFromFdm(selection.appName, zone.fdm);
  return { elected, placed: [] };
}

/**
 * Process a single selected app - update DNS if needed.
 * @param {Object} selection - what to publish for this app, from the selector
 * @returns {Promise<number>} Number of zones successfully updated
 */
async function processApp(selection) {
  const { appName } = selection;
  let updatedCount = 0;

  for (const zone of config.dns.zones) {
    // eslint-disable-next-line no-await-in-loop
    const state = await resolveState(selection, zone);
    const plan = recordPlanner.planRecord(selection, state, zone);

    // No plan means nothing is known to point at right now. Leave whatever is
    // published in place: withdrawing hands the name to the zone wildcard, which
    // answers with a proxy address the client cannot use and is cached far longer
    // than the record would have been.
    if (!plan) {
      log.debug(`No address known for ${appName} in ${zone.name}, leaving DNS as-is`);
      continue;
    }

    if (!hasIPsChanged(appName, plan.contents, zone.name)) {
      log.debug(`No DNS change needed for ${appName} in ${zone.name}`);
      continue;
    }

    log.info(`Updating DNS for ${appName} in ${zone.name}: ${plan.contents.join(', ')}`);

    try {
      // eslint-disable-next-line no-await-in-loop
      await dnsGateway.createGameDNSRecords(appName, plan.contents, zone.name, plan.ttl);
      updateDNSState(appName, plan.contents, zone.name);
      log.info(`DNS updated for ${appName}.${zone.name} -> ${plan.contents.join(', ')}`);
      updatedCount += 1;
    } catch (error) {
      log.error(`Failed to update DNS for ${appName} in ${zone.name}: ${error.message}`);
      // Continue processing other zones
    }
  }

  return updatedCount;
}

/**
 * Handle cleanup of DNS records for removed apps
 * Iterates the apps we currently manage DNS for; any that have been absent from
 * the network continuously for the grace period have their records deleted.
 * @param {Set<string>} currentSeenApps - Apps seen in current loop
 */
async function handleRemovedApps(currentSeenApps) {
  const currentTime = Date.now();
  const gracePeriodMs = config.games.deletionGracePeriodMs;

  // Snapshot keys: we mutate appsDNSState while iterating.
  for (const appName of [...appsDNSState.keys()]) {
    // Present this loop - cancel any pending deletion.
    if (currentSeenApps.has(appName)) {
      if (appLastSeenTimestamps.delete(appName)) {
        log.info(`App ${appName} reappeared, canceling deletion`);
      }
      continue;
    }

    // Missing - start the grace period the first time we notice it's gone.
    if (!appLastSeenTimestamps.has(appName)) {
      appLastSeenTimestamps.set(appName, currentTime);
      const gracePeriodMinutes = Math.round(gracePeriodMs / 1000 / 60);
      log.info(`App ${appName} not found, starting ${gracePeriodMinutes} minute grace period`);
      continue;
    }

    // Still within the grace period - wait.
    const elapsedMs = currentTime - appLastSeenTimestamps.get(appName);
    if (elapsedMs < gracePeriodMs) {
      continue;
    }

    // Missing long enough - delete from all configured zones.
    const elapsedMinutes = Math.round(elapsedMs / 1000 / 60);
    log.info(`App ${appName} missing for ${elapsedMinutes} minutes, deleting DNS records from all zones`);

    let deletedCount = 0;
    for (const zone of config.dns.zones) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await dnsGateway.deleteGameDNSRecords(appName, zone.name);
        deletedCount += 1;
      } catch (error) {
        log.error(`Failed to delete DNS records for ${appName} in ${zone.name}: ${error.message}`);
        // Continue deleting from other zones
      }
    }

    // Clean up state
    appsDNSState.delete(appName);
    appLastSeenTimestamps.delete(appName);
    log.info(`Deleted DNS records for removed app ${appName} from ${deletedCount}/${config.dns.zones.length} zones`);
  }
}

/**
 * Main processing loop - fetch apps and update DNS
 */
async function runProcessingLoop() {
  if (isRunning) {
    log.warn('Processing loop already running, skipping');
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    log.info('Starting apps DNS processing loop');

    // Fetch all app specifications
    const allAppSpecs = await fluxApi.getAppSpecifications();
    if (!allAppSpecs.length) {
      log.warn('No app specifications received from Flux API');
      return;
    }

    // Which apps we serve, and what shape their record takes. Owners declare a
    // DNS route from v9 on; older apps are recognised the way they always were.
    const { selections, unreadable } = await appResolver.resolveAll(allAppSpecs, {
      gameTypes: config.games.gameTypes,
    });
    const declared = selections.filter((s) => s.source === 'declared').length;
    log.info(
      `Serving ${selections.length} apps (${declared} declared, `
      + `${selections.length - declared} legacy)`
      + `${unreadable.length ? `, ${unreadable.length} unreadable` : ''}`,
    );

    // What counts as still being here. An app we could not read is included
    // deliberately: its records are only removed once the network stops carrying
    // it, and a spec we failed to open says nothing about whether it is still
    // deployed. Without this a decrypt outage would age out every sealed app and
    // withdraw its name.
    const currentSeenApps = new Set([
      ...selections.map((s) => s.appName),
      ...unreadable,
    ]);

    // Process each app - resolve where it is and update DNS if needed
    let zoneUpdatesCount = 0;
    for (const selection of selections) {
      // eslint-disable-next-line no-await-in-loop
      const zonesUpdated = await processApp(selection);
      zoneUpdatesCount += zonesUpdated;
    }

    // Handle cleanup of removed apps
    await handleRemovedApps(currentSeenApps);

    const elapsedMs = Date.now() - startTime;
    log.info(`Apps DNS loop completed: ${selections.length} apps, ${zoneUpdatesCount} zone updates, ${elapsedMs}ms`);
  } catch (error) {
    log.error(`Error in apps DNS processing loop: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the apps DNS manager service
 */
async function start() {
  log.info('Starting Apps DNS Manager service');

  // Initialize DNS Gateway client
  const dnsReady = dnsGateway.initializeClient();
  if (!dnsReady) {
    log.error('Failed to initialize DNS Gateway - service will not update DNS records');
    log.info('Check dnsGatewayConfig.js configuration');
  }

  // Initialize spec decryptor for encrypted apps (graceful - cleartext apps still work).
  // Registering the decrypt providers is async, so this is awaited before the first
  // sweep: starting without it would read every sealed spec as unreadable and log a
  // failure for each one.
  const decryptorReady = await specDecryptor.initialize();
  if (!decryptorReady) {
    log.warn('Spec decryptor not available - encrypted apps will be skipped');
  }

  // Run initial loop
  runProcessingLoop();

  // Start polling loop
  pollingInterval = setInterval(
    runProcessingLoop,
    config.games.pollingIntervalMs,
  );

  log.info(`Apps DNS Manager started, polling every ${config.games.pollingIntervalMs / 1000}s`);
}

/**
 * Stop the apps DNS manager service
 */
function stop() {
  log.info('Stopping Apps DNS Manager service');
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

/**
 * Get current service status
 * @returns {Object} Status object
 */
function getStatus() {
  return {
    running: pollingInterval !== null,
    dnsGatewayEnabled: dnsGateway.isReady(),
    trackedApps: appsDNSState.size,
    pendingDeletions: appLastSeenTimestamps.size,
    managedApps: [...appsDNSState.keys()],
  };
}

/**
 * Get DNS state for all tracked apps
 * @returns {Object} Nested map of app names to zones to their DNS IPs
 */
function getDNSState() {
  const state = {};
  for (const [appName, zoneMap] of appsDNSState) {
    state[appName] = {};
    for (const [zone, ips] of zoneMap) {
      state[appName][zone] = ips;
    }
  }
  return state;
}

module.exports = {
  start,
  stop,
  getStatus,
  getDNSState,
  runProcessingLoop,
};
