const config = require('config');
const log = require('../lib/log');
const fluxApi = require('./fluxApi');
const dnsGateway = require('./dnsGateway');
const specDecryptor = require('./specDecryptor');
const appResolver = require('./appResolver');
const recordPlanner = require('./recordPlanner');
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
// an address and an A once one is known. It decides whether an address is written as a
// replacement or as a swap, and which type is removed when an app goes away.
const appsDNSState = new Map();

// What the zones actually hold, refreshed once per sweep. Keyed by the name PowerDNS
// stores, which is lower case - so an app whose spec name carries capitals still finds
// its own record instead of concluding it has none.
//
// This exists because the service's memory of what it published does not survive a
// restart. Without it, the first sweep after every deploy re-asserts every address it
// manages - hundreds of PATCHes that change nothing, each bumping the zone serial and
// starting a transfer to three secondaries.
// Map<zoneName, Map<lowercaseName, { type, contents }>>
const publishedIndex = new Map();

// Track when each app was last seen (for deletion grace period)
// Map<appName, timestamp> - only starts tracking when app disappears
const appLastSeenTimestamps = new Map();

// Polling state
let isRunning = false;
let pollingInterval = null;

/**
 * Read every zone into the published index. A zone that cannot be read keeps whatever
 * index it had: a stale view is closer to the truth than no view, which would have the
 * sweep re-assert every record it manages.
 */
async function refreshPublishedIndex() {
  for (const zone of config.dns.zones) {
    const suffix = `.${zone.name}.`;
    try {
      // eslint-disable-next-line no-await-in-loop
      const rrsets = await dnsGateway.getZoneRecords(zone.name);
      const index = new Map();
      rrsets
        .filter((rrset) => rrset.type === 'A' || rrset.type === 'CNAME')
        .filter((rrset) => String(rrset.name).toLowerCase().endsWith(suffix))
        .forEach((rrset) => {
          const name = String(rrset.name).toLowerCase().slice(0, -suffix.length);
          index.set(name, {
            type: rrset.type,
            contents: (rrset.records || []).map((record) => record.content),
          });
        });
      publishedIndex.set(zone.name, index);
    } catch (error) {
      log.warn(`Could not read ${zone.name} to see what is already published: ${error.message}`);
    }
  }
}

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
 * @param {number|null} at - When it was published, or null when adopted from the zone
 */
function recordPublished(appName, zone, type, contents, at = Date.now()) {
  let appState = appsDNSState.get(appName);
  if (!appState) {
    appState = new Map();
    appsDNSState.set(appName, appState);
  }
  appState.set(zone, { type, contents: [...contents], at });
}

/**
 * What the name currently answers with: what this service published during this run,
 * and failing that what the zone itself holds.
 *
 * A record found in the zone is adopted into state, so the rest of a sweep treats it as
 * known - which is the whole point, since it is what stops a restart rewriting records
 * that are already correct.
 *
 * @param {string} appName - Application name
 * @param {string} zone - DNS zone
 * @returns {{type: string, contents: string[]}|undefined}
 */
function knownRecord(appName, zone) {
  const remembered = publishedRecord(appName, zone);
  if (remembered) return remembered;

  const index = publishedIndex.get(zone);
  const found = index ? index.get(String(appName).toLowerCase()) : undefined;
  if (!found) return undefined;

  // Adopted, not published by us: there is no moment to measure a placeholder's life
  // from, so `at` stays unset and the duration is simply not reported.
  recordPublished(appName, zone, found.type, found.contents, null);
  return publishedRecord(appName, zone);
}

/**
 * Check whether the addresses we would publish differ from what we already did.
 *
 * A name standing in for an address holds a director's hostname, which never equals an
 * address, so this always reports a change when a plan follows a placeholder. What that
 * plan is written AS is decided from the published record's type, not here.
 *
 * @param {string} appName - Application name
 * @param {string} zone - DNS zone
 * @param {string[]} addresses - Addresses to publish
 * @returns {boolean} True if they differ, or nothing has been published yet
 */
function hasAddressChanged(appName, zone, addresses) {
  const published = knownRecord(appName, zone);
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
 * better answer than the placeholder in every case: an address if the platform has
 * reported one, and the placeholder itself if it has not.
 *
 * @param {string} appName - Application name
 * @param {Object} zone - Zone config
 * @returns {Promise<boolean>} Whether a placeholder was published
 */
async function publishPlaceholder(appName, zone) {
  // A zone with no placeholder configured keeps its previous behaviour.
  if (!zone.placeholder) return false;

  // Anything already published for the name - written during this run, or found in the
  // zone. This is the guard that stops a placeholder ever replacing a live app's
  // address, and it consults the zone rather than trusting memory, which is empty after
  // a restart. Matching is case-insensitive, so an app whose name carries capitals is
  // not mistaken for one that has no record at all.
  if (knownRecord(appName, zone.name)) {
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
 * Publish what one zone should answer for one app.
 * @param {Object} selection - what to publish for this app, from the selector
 * @param {Object} zone - Zone config
 * @returns {Promise<boolean>} Whether anything was written
 */
async function processZone(selection, zone) {
  const { appName } = selection;
  const state = await resolveState(selection, zone);
  const plan = recordPlanner.planRecord(selection, state, zone);

  // No plan means nothing is known to point at right now, and what that should produce
  // depends on whether the name already answers. For a name with a record, leaving it
  // alone is right: withdrawing hands the name to the zone wildcard, which answers with
  // a proxy address the client cannot use and is cached far longer than the record
  // would have been. For a name with no record, that wildcard is ALREADY what answers -
  // so standing in for its answer at a TTL of a minute is the only thing that shortens
  // how long a client which asked too early stays wrong.
  if (!plan) {
    log.debug(`No address known for ${appName} in ${zone.name}`);
    return publishPlaceholder(appName, zone);
  }

  if (!hasAddressChanged(appName, zone.name, plan.contents)) {
    log.debug(`No DNS change needed for ${appName} in ${zone.name}`);
    return false;
  }

  log.info(`Updating DNS for ${appName} in ${zone.name}: ${plan.contents.join(', ')}`);

  const published = knownRecord(appName, zone.name);
  try {
    if (published && published.type === 'A') {
      // Steady state: the addresses are replaced in place, as they always have been.
      await dnsGateway.createGameDNSRecords(appName, plan.contents, zone.name, plan.ttl);
    } else {
      // Either this service published the placeholder, or it has no memory of the name
      // and one may be left from a previous run. PowerDNS will not add an A record to a
      // name that still carries a CNAME, so the addresses have to arrive in the same
      // transaction that removes it - and removing a CNAME that is not there costs
      // nothing, which makes this the safe form for any first write.
      await dnsGateway.swapPlaceholderForAddresses(appName, plan.contents, zone.name, plan.ttl);
    }
    if (published && published.type === 'CNAME' && published.at) {
      // The whole point of the placeholder, as a number: how long this name answered
      // with the director before it could answer with a node. Against the ~15 minutes
      // it would previously have spent being answered by the wildcard at an hour's TTL.
      const stoodInFor = Math.round((Date.now() - published.at) / 1000);
      log.info(`${appName}.${zone.name} stood in for ${stoodInFor}s before an address was known`);
    }
    recordPublished(appName, zone.name, 'A', plan.contents);
    log.info(`DNS updated for ${appName}.${zone.name} -> ${plan.contents.join(', ')}`);
    return true;
  } catch (error) {
    log.error(`Failed to update DNS for ${appName} in ${zone.name}: ${error.message}`);
    // Other zones are still worth doing
    return false;
  }
}

/**
 * Process a single selected app - update DNS in every configured zone if needed.
 * @param {Object} selection - what to publish for this app, from the selector
 * @returns {Promise<number>} Number of zones successfully updated
 */
async function processApp(selection) {
  let updatedCount = 0;
  for (const zone of config.dns.zones) {
    // eslint-disable-next-line no-await-in-loop
    const updated = await processZone(selection, zone);
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
    // Remove the type that was actually published. An app removed before anything was
    // ever known to point at is carrying a placeholder CNAME, and deleting an A record
    // would leave that placeholder answering for the name for as long as the zone exists.
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

    // What the zones already hold, before deciding what needs writing. Without this the
    // first sweep after a restart rewrites every record this service manages.
    await refreshPublishedIndex();

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
