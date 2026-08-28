const config = require('config');
const log = require('../lib/log');
const fluxApi = require('./fluxApi');
const dnsGateway = require('./dnsGateway');
const specDecryptor = require('./specDecryptor');
const gModeResolver = require('./gModeResolver');
const placeholder = require('./placeholder');

// Apps and zones are worked through one at a time on purpose: a sweep issues a call per
// app per zone, and starting them all at once would reach FDM and the gateway as a
// burst. `for...of` is how sequential awaiting is expressed - airbnb bans it for browser
// bundles that would need regenerator-runtime, which a Node service does not.
/* eslint-disable no-restricted-syntax */

// What this service has published for each app, per zone: the record type and its
// contents. Tracks current DNS state per app - persists until service restart.
// Memory bounded by active app count (~10-50 apps).
//
// The type is part of the state because a name is a CNAME while it is standing in for
// an address and an A once FDM has elected one. Without it, the director's name would
// be compared against a list of addresses and every cycle would read as a change.
const appsDNSState = new Map();

// Track when each app was last seen (for deletion grace period)
// Map<appName, timestamp> - only starts tracking when app disappears
const appLastSeenTimestamps = new Map();

// Polling state
let isRunning = false;
let pollingInterval = null;

/**
 * What this service last published for an app in a zone, if anything
 * @param {string} appName - Application name
 * @param {string} zone - DNS zone
 * @returns {{type: string, contents: string[]}|undefined}
 */
function publishedRecord(appName, zone) {
  const appState = appsDNSState.get(appName);
  return appState ? appState.get(zone) : undefined;
}

/**
 * Record what was published, after the gateway has accepted it
 * @param {string} appName - Application name
 * @param {string} zone - DNS zone
 * @param {string} type - Record type published
 * @param {string[]} contents - Record contents published
 */
function recordPublished(appName, zone, type, contents) {
  let appState = appsDNSState.get(appName);
  if (!appState) {
    appState = new Map();
    appsDNSState.set(appName, appState);
  }
  appState.set(zone, { type, contents: [...contents] });
}

/**
 * Check whether the addresses we would publish differ from what we already did.
 *
 * A name standing in for an address holds a director's hostname, which never equals an
 * address, so this always reports a change when an election follows a placeholder. What
 * that election should be written AS is decided from the published record's type, not
 * here.
 *
 * @param {string} appName - Application name
 * @param {string} zone - DNS zone
 * @param {string[]} addresses - Addresses to publish
 * @returns {boolean} True if they differ, or nothing has been published yet
 */
function hasAddressChanged(appName, zone, addresses) {
  const published = publishedRecord(appName, zone);
  if (!published) return true;

  // Compare contents (order-independent)
  const publishedSet = new Set(published.contents);
  const wantedSet = new Set(addresses);

  if (publishedSet.size !== wantedSet.size) return true;

  return [...wantedSet].some((value) => !publishedSet.has(value));
}

/**
 * Give a name with nothing published for it the same answer the zone's wildcard is
 * already giving, at a TTL of a minute rather than the zone default of an hour.
 *
 * Only ever for a name that has no record at all. Whatever is already published is a
 * better answer than the placeholder in every case: an address if FDM has spoken, and
 * the placeholder itself if it has not.
 *
 * @param {string} appName - Application name
 * @param {Object} zone - Zone config
 * @returns {Promise<boolean>} Whether a placeholder was published
 */
async function publishPlaceholder(appName, zone) {
  // A zone with no placeholder configured keeps its previous behaviour.
  if (!zone.placeholder) return false;

  // Anything this service has published for the name during this run.
  if (publishedRecord(appName, zone.name)) return false;

  // ...and anything published before it started. Our own memory is empty after a
  // restart, so what exists is read rather than assumed. This is the guard that stops
  // a placeholder ever being written over a live app's address.
  let existing;
  try {
    existing = await dnsGateway.getRecordsForName(appName, zone.name);
  } catch (error) {
    log.error(`Could not read what is published for ${appName} in ${zone.name}: ${error.message}`);
    return false;
  }

  if (existing && existing.length) {
    log.debug(`${appName}.${zone.name} already has a record; not standing in for it`);
    return false;
  }

  // With nothing published, the zone can only be answering from its wildcard - so what
  // it returns is exactly the answer this has to stand in for, at a TTL we choose.
  const target = await placeholder.wildcardAnswerFor(appName, zone);
  if (!target) return false;

  try {
    await dnsGateway.createPlaceholderRecord(appName, target, zone.name, zone.placeholder.ttl);
    recordPublished(appName, zone.name, 'CNAME', [target]);
    log.info(`No address for ${appName} in ${zone.name} yet; standing in with ${target} at ttl ${zone.placeholder.ttl}`);
    return true;
  } catch (error) {
    log.error(`Failed to publish placeholder for ${appName} in ${zone.name}: ${error.message}`);
    return false;
  }
}

/**
 * Publish what one zone should answer for one app.
 * Gets the master IP from FDM (Flux Domain Manager) which knows the current HAProxy
 * state; with no elected address, stands in for the zone's own wildcard answer instead.
 * @param {string} appName - Application name
 * @param {Object} zone - Zone config
 * @returns {Promise<boolean>} Whether anything was written
 */
async function processZone(appName, zone) {
  // Get the master IP from FDM using zone-specific FDM config
  const masterIP = await fluxApi.getAppMasterIpFromFdm(appName, zone.fdm);

  if (!masterIP) {
    // The name is already public and already resolving - to the zone's wildcard, at an
    // hour's TTL. Standing in for that answer under the app's own name at a minute's
    // TTL is the difference between a client that asked too early being wrong for an
    // hour and being wrong for a minute.
    return publishPlaceholder(appName, zone);
  }

  // Clean the master IP (remove any brackets for IPv6)
  const cleanMasterIP = masterIP.replace(/\[|\]/g, '');

  // Check if DNS update is needed for this zone
  if (!hasAddressChanged(appName, zone.name, [cleanMasterIP])) {
    log.debug(`No DNS change needed for ${appName} in ${zone.name}`);
    return false;
  }

  log.info(`Updating DNS for ${appName} in ${zone.name}: ${cleanMasterIP}`);

  const published = publishedRecord(appName, zone.name);
  try {
    if (published && published.type === 'A') {
      // Steady state: a master move replaces the address in place, as it always has.
      await dnsGateway.createGameDNSRecords(appName, [cleanMasterIP], zone.name, zone.ttl);
    } else {
      // Either this service published the placeholder, or it has no memory of the name
      // and one may be left from a previous run. PowerDNS will not add an A record to a
      // name that still carries a CNAME, so the address has to arrive in the same
      // transaction that removes it - and removing a CNAME that is not there costs
      // nothing, which makes this the safe form for any first write.
      await dnsGateway.swapPlaceholderForAddresses(appName, [cleanMasterIP], zone.name, zone.ttl);
    }
    recordPublished(appName, zone.name, 'A', [cleanMasterIP]);
    log.info(`DNS updated for ${appName}.${zone.name} -> ${cleanMasterIP}`);
    return true;
  } catch (error) {
    log.error(`Failed to update DNS for ${appName} in ${zone.name}: ${error.message}`);
    // Other zones are still worth doing
    return false;
  }
}

/**
 * Process a single app - update DNS in every configured zone if needed
 * @param {string} appName - Application name
 * @returns {Promise<number>} Number of zones successfully updated
 */
async function processApp(appName) {
  let updatedCount = 0;
  for (const zone of config.dns.zones) {
    // eslint-disable-next-line no-await-in-loop
    const updated = await processZone(appName, zone);
    if (updated) updatedCount += 1;
  }

  return updatedCount;
}

/**
 * Delete an app's records from every configured zone.
 * @param {string} appName - Application name
 * @returns {Promise<number>} Number of zones deleted from
 */
async function deleteFromAllZones(appName) {
  let deletedCount = 0;
  for (const zone of config.dns.zones) {
    // Remove the type that was actually published. An app removed before it was ever
    // elected is carrying a placeholder CNAME, and deleting an A record would leave that
    // placeholder answering for the name for as long as the zone exists.
    const published = publishedRecord(appName, zone.name);
    try {
      // eslint-disable-next-line no-await-in-loop
      await dnsGateway.deleteGameDNSRecords(appName, zone.name, published ? published.type : 'A');
      deletedCount += 1;
    } catch (error) {
      log.error(`Failed to delete DNS records for ${appName} in ${zone.name}: ${error.message}`);
      // Other zones are still worth deleting from
    }
  }

  return deletedCount;
}

/**
 * What one app's absence means this loop: nothing yet, the start of its grace period,
 * or the end of it.
 * @param {string} appName - Application name
 * @param {Set<string>} currentSeenApps - Apps seen in current loop
 * @param {number} currentTime - Time this loop started
 * @param {number} gracePeriodMs - How long an app may be absent before its records go
 */
async function reconcileAbsence(appName, currentSeenApps, currentTime, gracePeriodMs) {
  // Present this loop - cancel any pending deletion.
  if (currentSeenApps.has(appName)) {
    if (appLastSeenTimestamps.delete(appName)) {
      log.info(`App ${appName} reappeared, canceling deletion`);
    }
    return;
  }

  // Missing - start the grace period the first time we notice it's gone.
  if (!appLastSeenTimestamps.has(appName)) {
    appLastSeenTimestamps.set(appName, currentTime);
    const gracePeriodMinutes = Math.round(gracePeriodMs / 1000 / 60);
    log.info(`App ${appName} not found, starting ${gracePeriodMinutes} minute grace period`);
    return;
  }

  // Still within the grace period - wait.
  const elapsedMs = currentTime - appLastSeenTimestamps.get(appName);
  if (elapsedMs < gracePeriodMs) {
    return;
  }

  // Missing long enough - delete from all configured zones.
  const elapsedMinutes = Math.round(elapsedMs / 1000 / 60);
  log.info(`App ${appName} missing for ${elapsedMinutes} minutes, deleting DNS records from all zones`);

  const deletedCount = await deleteFromAllZones(appName);

  // Clean up state
  appsDNSState.delete(appName);
  appLastSeenTimestamps.delete(appName);
  log.info(`Deleted DNS records for removed app ${appName} from ${deletedCount}/${config.dns.zones.length} zones`);
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
    // eslint-disable-next-line no-await-in-loop
    await reconcileAbsence(appName, currentSeenApps, currentTime, gracePeriodMs);
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

    // Resolve the G-mode game apps (decrypts enterprise specs only as needed)
    const gameAppNames = await gModeResolver.resolveGameAppNames(
      allAppSpecs,
      config.games.gameTypes,
    );
    log.info(`Found ${gameAppNames.length} G-mode game apps`);

    // Track apps seen in this loop
    const currentSeenApps = new Set(gameAppNames);

    // Process each app - get master IP from FDM and update DNS if needed
    let zoneUpdatesCount = 0;
    for (const appName of gameAppNames) {
      // eslint-disable-next-line no-await-in-loop
      const zonesUpdated = await processApp(appName);
      zoneUpdatesCount += zonesUpdated;
    }

    // Handle cleanup of removed apps
    await handleRemovedApps(currentSeenApps);

    const elapsedMs = Date.now() - startTime;
    log.info(`Apps DNS loop completed: ${gameAppNames.length} apps, ${zoneUpdatesCount} zone updates, ${elapsedMs}ms`);
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

  // Initialize spec decryptor for enterprise apps (graceful - non-enterprise apps still work)
  const decryptorReady = specDecryptor.initialize();
  if (!decryptorReady) {
    log.warn('Spec decryptor not available - enterprise apps will be skipped');
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
 *
 * Reports the record type alongside the contents: a name that is standing in for an
 * address holds a director's name rather than a list of addresses, and a bare array
 * could not tell the two apart.
 *
 * @returns {Object} Nested map of app names to zones to their published record
 */
function getDNSState() {
  const state = {};
  appsDNSState.forEach((zoneMap, appName) => {
    state[appName] = {};
    zoneMap.forEach((published, zone) => {
      state[appName][zone] = { type: published.type, contents: [...published.contents] };
    });
  });
  return state;
}

module.exports = {
  start,
  stop,
  getStatus,
  getDNSState,
  runProcessingLoop,
};
