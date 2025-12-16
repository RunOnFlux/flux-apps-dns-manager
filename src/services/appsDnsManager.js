const config = require('config');
const log = require('../lib/log');
const fluxApi = require('./fluxApi');
const dnsGateway = require('./dnsGateway');

// DNS state tracking to prevent unnecessary updates
// Tracks current DNS state per app - persists until service restart
// Memory bounded by active app count (~10-50 apps)
const appsDNSState = new Map();

// Track which apps were seen in the last loop
// Used to detect when apps are removed from the network
let lastSeenApps = new Set();

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
 * Process a single app - update DNS if needed
 * Gets the master IP from FDM (Flux Domain Manager) which knows the current HAProxy state
 * @param {Object} app - App specification
 * @returns {Promise<number>} Number of zones successfully updated
 */
async function processApp(app) {
  const appName = app.name;

  // Get the master IP from FDM - this is the IP currently set in HAProxy
  const masterIP = await fluxApi.getAppMasterIpFromFdm(appName);

  if (!masterIP) {
    log.debug(`No master IP available from FDM for ${appName}, skipping`);
    return 0;
  }

  // Clean the master IP (remove any brackets for IPv6)
  const cleanMasterIP = masterIP.replace(/\[|\]/g, '');

  // Process each configured zone
  let updatedCount = 0;
  for (const zone of config.dns.zones) {
    // Check if DNS update is needed for this zone
    if (!hasIPsChanged(appName, [cleanMasterIP], zone.name)) {
      log.debug(`No DNS change needed for ${appName} in ${zone.name}`);
      continue;
    }

    log.info(`Updating DNS for ${appName} in ${zone.name}: ${cleanMasterIP}`);

    try {
      await dnsGateway.createGameDNSRecords(appName, [cleanMasterIP], zone.name, zone.ttl);
      updateDNSState(appName, [cleanMasterIP], zone.name);
      log.info(`DNS updated for ${appName}.${zone.name} -> ${cleanMasterIP}`);
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
 * Uses grace period to prevent accidental deletion
 * @param {Set<string>} currentSeenApps - Apps seen in current loop
 */
async function handleRemovedApps(currentSeenApps) {
  const currentTime = Date.now();
  const gracePeriodMs = config.games.deletionGracePeriodMs;

  // Find apps that were in lastSeenApps but not in currentSeenApps
  const removedApps = [...lastSeenApps].filter(
    (appName) => !currentSeenApps.has(appName),
  );

  for (const appName of removedApps) {
    const cachedState = appsDNSState.get(appName);

    // Only process if we have DNS state for this app
    if (!cachedState || cachedState.size === 0) {
      continue;
    }

    // Track when we first noticed this app was missing
    if (!appLastSeenTimestamps.has(appName)) {
      appLastSeenTimestamps.set(appName, currentTime);
      const gracePeriodMinutes = Math.round(gracePeriodMs / 1000 / 60);
      log.info(`App ${appName} not found, starting ${gracePeriodMinutes} minute grace period`);
      continue;
    }

    // Check if grace period has elapsed
    const firstMissingTime = appLastSeenTimestamps.get(appName);
    const elapsedMs = currentTime - firstMissingTime;

    if (elapsedMs >= gracePeriodMs) {
      const elapsedMinutes = Math.round(elapsedMs / 1000 / 60);
      log.info(`App ${appName} missing for ${elapsedMinutes} minutes, deleting DNS records from all zones`);

      // Delete from all configured zones
      let deletedCount = 0;
      for (const zone of config.dns.zones) {
        try {
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

  // Clear timestamps for apps that reappeared
  for (const appName of currentSeenApps) {
    if (appLastSeenTimestamps.has(appName)) {
      log.info(`App ${appName} reappeared, canceling deletion`);
      appLastSeenTimestamps.delete(appName);
    }
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

    // Filter to get only G-mode apps
    const matchedApps = fluxApi.filterGameApps(allAppSpecs, config.games.gameTypes);
    log.info(`Found ${matchedApps.length} G-mode apps`);

    // Track apps seen in this loop
    const currentSeenApps = new Set();

    // Process each app - get master IP from FDM and update DNS if needed
    let zoneUpdatesCount = 0;
    for (const app of matchedApps) {
      currentSeenApps.add(app.name);

      // eslint-disable-next-line no-await-in-loop
      const zonesUpdated = await processApp(app);
      zoneUpdatesCount += zonesUpdated;
    }

    // Handle cleanup of removed apps
    await handleRemovedApps(currentSeenApps);

    // Update tracking for next loop
    lastSeenApps = currentSeenApps;

    const elapsedMs = Date.now() - startTime;
    log.info(`Apps DNS loop completed: ${matchedApps.length} apps, ${zoneUpdatesCount} zone updates, ${elapsedMs}ms`);
  } catch (error) {
    log.error(`Error in apps DNS processing loop: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the apps DNS manager service
 */
function start() {
  log.info('Starting Apps DNS Manager service');

  // Initialize DNS Gateway client
  const dnsReady = dnsGateway.initializeClient();
  if (!dnsReady) {
    log.error('Failed to initialize DNS Gateway - service will not update DNS records');
    log.info('Check dnsGatewayConfig.js configuration');
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
    lastSeenApps: [...lastSeenApps],
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
