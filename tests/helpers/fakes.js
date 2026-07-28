// Stand-ins for the two collaborators the sweep talks to: the network's app API and
// the DNS gateway. Both are swapped in by overwriting the cached module's exports,
// which needs no injection seam in the service and no stubbing library.
//
// The gateway fake records what it was asked to do rather than asserting inline, so
// a test can say what should NOT have happened as easily as what should — which is
// most of what matters here, since the dangerous outcomes are a record withdrawn or
// rewritten when it should have been left alone.
const dnsGateway = require('../../src/services/dnsGateway');
const fluxApi = require('../../src/services/fluxApi');

/**
 * A gateway that writes nowhere and remembers everything.
 */
function fakeGateway() {
  const writes = [];
  const deletes = [];
  return {
    writes,
    deletes,
    /** Every address written for an app, latest first, across all zones. */
    writesFor(appName) {
      return writes.filter((w) => w.appName === appName);
    },
    deletesFor(appName) {
      return deletes.filter((d) => d.appName === appName);
    },
    impl: {
      initializeClient: () => true,
      isReady: () => true,
      createGameDNSRecords: async (appName, contents, zone, ttl) => {
        writes.push({
          appName, contents, zone, ttl,
        });
      },
      deleteGameDNSRecords: async (appName, zone) => {
        deletes.push({ appName, zone });
      },
    },
  };
}

/**
 * The network's view: which apps exist, which instance is elected, where each is
 * placed. Every field is settable per test.
 */
function fakeFluxApi({ specs = [], elected = {}, locations = {} } = {}) {
  const state = { specs, elected, locations };
  return {
    state,
    impl: {
      getAppSpecifications: async () => state.specs,
      getAppMasterIpFromFdm: async (appName) => state.elected[appName] || null,
      getApplicationLocation: async (appName) => (state.locations[appName] || [])
        .map((ip) => ({ ip })),
      getAllApplicationLocations: async () => new Map(),
    },
  };
}

/**
 * Install fakes over the real modules and hand back a restore function. Snapshots
 * only the keys it replaces, so anything else on those modules is left alone.
 */
function install({ gateway, api }) {
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
 * would inherit the previous one's published set.
 */
function freshManager() {
  delete require.cache[require.resolve('../../src/services/appsDnsManager')];
  // eslint-disable-next-line global-require
  return require('../../src/services/appsDnsManager');
}

/**
 * Run `body` with the clock reporting `now`, then put the real clock back.
 * The deletion grace period is a day long, so expiry is unreachable in a test
 * without moving time.
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

module.exports = {
  fakeGateway, fakeFluxApi, install, freshManager, atTime,
};
