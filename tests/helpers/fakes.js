// Stand-ins for the three collaborators the sweep talks to: the network's app API, the
// DNS gateway, and the zone it asks what its wildcard answers. All are swapped in by
// overwriting the cached module's exports, which needs no injection seam in the service
// and no stubbing library.
//
// The gateway fake records what it was asked to do rather than asserting inline, so a
// test can say what should NOT have happened as easily as what should - which is most
// of what matters here, since the dangerous outcomes are a placeholder written over a
// live record, or an address written as two calls instead of one transaction.
const dnsGateway = require('../../src/services/dnsGateway');
const fluxApi = require('../../src/services/fluxApi');
const placeholder = require('../../src/services/placeholder');

/**
 * A gateway that writes nowhere and remembers everything.
 * `published` seeds what already exists in the zone, as the real gateway would report
 * it: Map of `appName@zone` to an array of records.
 */
function fakeGateway({ published = new Map() } = {}) {
  const writes = [];
  const placeholders = [];
  const swaps = [];
  const deletes = [];
  const reads = [];
  return {
    writes,
    placeholders,
    swaps,
    deletes,
    reads,
    published,
    inZone(list, zone) {
      return list.filter((entry) => entry.zone === zone);
    },
    impl: {
      initializeClient: () => true,
      isReady: () => true,
      createGameDNSRecords: async (appName, contents, zone, ttl) => {
        writes.push({
          appName, contents, zone, ttl,
        });
      },
      createPlaceholderRecord: async (appName, target, zone, ttl) => {
        placeholders.push({
          appName, target, zone, ttl,
        });
      },
      swapPlaceholderForAddresses: async (appName, contents, zone, ttl) => {
        swaps.push({
          appName, contents, zone, ttl,
        });
      },
      getRecordsForName: async (appName, zone) => {
        reads.push({ appName, zone });
        return published.get(`${appName}@${zone}`) || null;
      },
      deleteGameDNSRecords: async (appName, zone, recordType = 'A') => {
        deletes.push({ appName, zone, recordType });
      },
    },
  };
}

/**
 * The network's view: which apps exist and which instance FDM has elected.
 */
function fakeFluxApi({ specs = [], elected = {} } = {}) {
  const state = { specs, elected };
  return {
    state,
    impl: {
      getAppSpecifications: async () => state.specs,
      getAppMasterIpFromFdm: async (appName) => state.elected[appName] || null,
    },
  };
}

/**
 * The zone, answering what its wildcard would say for a name. `answers` maps an app
 * name to a director; anything absent resolves to null, which is what a lookup failure
 * looks like to the caller.
 */
function fakeZone({ answers = {} } = {}) {
  const asked = [];
  return {
    asked,
    answers,
    impl: {
      wildcardAnswerFor: async (appName, zone) => {
        asked.push({ appName, zone: zone.name });
        return answers[appName] || null;
      },
    },
  };
}

/**
 * Install fakes over the real modules and hand back a restore function. Snapshots only
 * the keys it replaces, so anything else on those modules is left alone.
 */
function install({ gateway, api, zone }) {
  const saved = [];
  const swap = (target, impl) => {
    Object.entries(impl).forEach(([key, value]) => {
      saved.push({ target, key, value: target[key] });
      // eslint-disable-next-line no-param-reassign
      target[key] = value;
    });
  };
  if (gateway) swap(dnsGateway, gateway.impl);
  if (api) swap(fluxApi, api.impl);
  if (zone) swap(placeholder, zone.impl);

  return function restore() {
    saved.forEach(({ target, key, value }) => {
      // eslint-disable-next-line no-param-reassign
      target[key] = value;
    });
  };
}

/**
 * A fresh copy of the sweep, with its in-memory record of what it has published
 * emptied. The service keeps that state at module scope, so without this every test
 * would inherit the previous one's published set - and "what have I already published"
 * is exactly what the placeholder guard turns on.
 */
function freshManager() {
  delete require.cache[require.resolve('../../src/services/appsDnsManager')];
  // eslint-disable-next-line global-require
  return require('../../src/services/appsDnsManager');
}

/**
 * Run `body` with the clock reporting `now`, then put the real clock back. The deletion
 * grace period is a day long, so expiry is unreachable in a test without moving time.
 */
async function atTime(now, body) {
  const real = Date.now;
  Date.now = () => now;
  try {
    await body();
  } finally {
    Date.now = real;
  }
}

/**
 * A legacy G-mode game app spec, the shape this service selects on today.
 */
function gameSpec({ name = 'palworldtest', containerData = 'g:/data' } = {}) {
  return {
    version: 7,
    name,
    compose: [{
      name: 'app',
      repotag: 'runonflux/palworld-server-flux:latest',
      ports: [31000],
      containerPorts: [8211],
      containerData,
    }],
    instances: 3,
  };
}

module.exports = {
  fakeGateway, fakeFluxApi, fakeZone, install, freshManager, atTime, gameSpec,
};
