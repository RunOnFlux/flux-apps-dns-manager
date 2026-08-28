// Stand-ins for the two collaborators the sweep talks to: the network's app API and
// the DNS gateway. Both are swapped in by overwriting the cached module's exports,
// which needs no injection seam in the service and no stubbing library.
//
// The gateway fake records what it was asked to do rather than asserting inline, so
// a test can say what should NOT have happened as easily as what should — which is
// most of what matters here, since the dangerous outcomes are a record withdrawn or
// rewritten when it should have been left alone.
const config = require('config');
const dnsGateway = require('../../src/services/dnsGateway');
const fluxApi = require('../../src/services/fluxApi');
const placeholder = require('../../src/services/placeholder');

/**
 * A gateway that writes nowhere and remembers everything.
 * `published` seeds what the zones already hold: Map of `appName@zone` to
 * `{ type, contents }`, served back in the rrset shape the real gateway returns.
 */
function fakeGateway({ published = new Map(), unreadableZones = false } = {}) {
  // `writes` is every address publication, however it was sent - which is what most
  // tests mean by "what did it publish". The form matters in exactly one place, so the
  // two ways of sending one are also recorded apart: `plainWrites` replaced an existing
  // record, `swaps` crossed from a placeholder in a single transaction.
  const writes = [];
  const plainWrites = [];
  const swaps = [];
  const placeholders = [];
  const deletes = [];
  const reads = [];
  return {
    writes,
    plainWrites,
    swaps,
    placeholders,
    deletes,
    reads,
    published,
    /** Every address written for an app, latest first, across all zones. */
    writesFor(appName) {
      return writes.filter((w) => w.appName === appName);
    },
    deletesFor(appName) {
      return deletes.filter((d) => d.appName === appName);
    },
    placeholdersFor(appName) {
      return placeholders.filter((entry) => entry.appName === appName);
    },
    inZone(list, zone) {
      return list.filter((entry) => entry.zone === zone);
    },
    impl: {
      initializeClient: () => true,
      isReady: () => true,
      createGameDNSRecords: async (appName, contents, zone, ttl) => {
        const write = {
          appName, contents, zone, ttl,
        };
        writes.push(write);
        plainWrites.push(write);
      },
      swapPlaceholderForAddresses: async (appName, contents, zone, ttl) => {
        const write = {
          appName, contents, zone, ttl,
        };
        writes.push(write);
        swaps.push(write);
      },
      createPlaceholderRecord: async (appName, target, zone, ttl) => {
        placeholders.push({
          appName, target, zone, ttl,
        });
      },
      getZoneRecords: async (zone) => {
        reads.push({ zone });
        if (unreadableZones) throw new Error('zone unavailable');
        const rrsets = [];
        published.forEach((record, key) => {
          const [app, inZone] = key.split('@');
          if (inZone !== zone) return;
          rrsets.push({
            name: `${app}.${zone}.`.toLowerCase(),
            type: record.type,
            records: record.contents.map((content) => ({ content })),
          });
        });
        return rrsets;
      },
      deleteGameDNSRecords: async (appName, zone, recordType = 'A') => {
        deletes.push({ appName, zone, recordType });
      },
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

/**
 * Spec fixtures: the two shapes this service selects on. A pre-v9 app is recognised by
 * its name and its activeStandby marker; a v9 app declares the route it wants.
 */
// A name this service has historically routed, so a fixture defaults to one that is
// actually selected rather than to a name that would be filtered out.
const GAME_PREFIX = config.games.gameTypes[0];

function legacySpec({ name = `${GAME_PREFIX}app`, containerData = 'g:/data' } = {}) {
  return {
    version: 7,
    name,
    description: 'x',
    owner: '19z6SjrVrWqBTLiCXWLRjcu9ydnzWNz3UD',
    compose: [{
      name: 'app',
      description: 'app',
      repotag: 'nginx:latest',
      ports: [31000],
      domains: [''],
      environmentParameters: [],
      commands: [],
      containerPorts: [80],
      containerData,
      cpu: 0.1,
      ram: 100,
      hdd: 1,
      repoauth: '',
    }],
    instances: 3,
    contacts: [],
    geolocation: [],
    expire: 88000,
    nodes: [],
    staticip: false,
  };
}

function v9Spec({ name = 'declaredapp', strategy = 'roundRobin', ttl } = {}) {
  const dns = { provider: 'powerdns', strategy };
  if (ttl !== undefined) dns.ttl = ttl;
  return {
    version: 9,
    name,
    description: 'x',
    owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
    ttl: 2592000,
    instances: 3,
    contacts: { email: ['a@b.com'] },
    components: {
      web: {
        name: 'web',
        image: 'nginx:latest',
        cpu: 0.5,
        memory: 300,
        rootFsGb: 2,
        persistentStorage: {
          sizeGb: 5,
          mounts: { '/data': { source: 'data', destination: '/data' } },
          sync: null,
        },
        ports: { http: { containerPort: 80, hostPort: 31000 } },
        loadBalancing: { http: dns },
      },
    },
  };
}

module.exports = {
  fakeGateway,
  fakeFluxApi,
  fakeZone,
  install,
  freshManager,
  atTime,
  legacySpec,
  v9Spec,
};
