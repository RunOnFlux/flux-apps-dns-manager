const { expect } = require('chai');
const { deserialize, resolveDeployment } = require('../src/services/specLibs');
const selector = require('../src/services/appSelector');

const GAME_TYPES = ['minecraft', 'palworld', 'rustserver'];

function legacySpec({ name = 'minecraftflux', containerData = 'g:/data' } = {}) {
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

function v9Spec({ name = 'someapp', dns = { provider: 'powerdns' }, extra = {} } = {}) {
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
        loadBalancing: dns ? { http: dns } : undefined,
        ...extra,
      },
    },
  };
}

async function select(blob, gameTypes = GAME_TYPES) {
  const deployment = await resolveDeployment(await deserialize(blob));
  return selector.selectOne(deployment, blob.name, gameTypes);
}

describe('appSelector', () => {
  describe('declared intent (v9)', () => {
    it('serves an app that declares a powerdns route', async () => {
      const chosen = await select(v9Spec());
      expect(chosen).to.include({ appName: 'someapp', source: 'declared' });
    });

    it('defaults it to a single answer', async () => {
      const chosen = await select(v9Spec());
      expect(chosen.strategy).to.equal('failover');
    });

    it('carries the strategy and ttl the owner asked for', async () => {
      const chosen = await select(v9Spec({
        dns: { provider: 'powerdns', strategy: 'roundRobin', ttl: 120 },
      }));
      expect(chosen).to.include({ strategy: 'roundRobin', ttl: 120 });
    });

    // The name is not what selects a v9 app — the declaration is. An app named
    // nothing like a game is served, and a game-named one that declared nothing
    // and replicates nothing is not.
    it('serves a declared app regardless of its name', async () => {
      const chosen = await select(v9Spec({ name: 'ledgerthing' }));
      expect(chosen.source).to.equal('declared');
    });

    it('does not serve a v9 app that declared no DNS route', async () => {
      expect(await select(v9Spec({ dns: null }))).to.equal(null);
    });

    // An haproxy route is another service's business.
    it('does not serve a v9 app routed by the proxy', async () => {
      const chosen = await select(v9Spec({
        dns: { provider: 'haproxy', mode: 'http' },
      }));
      expect(chosen).to.equal(null);
    });
  });

  describe('legacy convention (pre-v9)', () => {
    it('serves an app matching a routed name that replicates active-standby', async () => {
      const chosen = await select(legacySpec());
      expect(chosen).to.include({ appName: 'minecraftflux', source: 'legacy' });
    });

    it('gives it a single answer and the zone default ttl', async () => {
      const chosen = await select(legacySpec());
      expect(chosen.strategy).to.equal('failover');
      expect(chosen.ttl).to.equal(null);
    });

    // Both conditions are required, exactly as today: the marker without a routed
    // name is one of the many active-standby apps we do not DNS-route, and a
    // routed name without the marker was never selected either.
    it('does not serve a routed name without the marker', async () => {
      expect(await select(legacySpec({ containerData: '/data' }))).to.equal(null);
    });

    it('does not serve the marker under an unrouted name', async () => {
      expect(await select(legacySpec({ name: 'odoo' }))).to.equal(null);
    });

    it('matches names by prefix, as today', async () => {
      const chosen = await select(legacySpec({ name: 'minecraftserver12345' }));
      expect(chosen.source).to.equal('legacy');
    });

    // flux-spec resolves the marker for every version, so this asks it rather
    // than parsing containerData. r: is a different mode and must not select.
    it('does not treat the sync-first marker as active-standby', async () => {
      expect(await select(legacySpec({ containerData: 'r:/data' }))).to.equal(null);
    });
  });

  describe('conflicting declarations', () => {
    // One name cannot resolve two ways. Refusing beats picking one silently.
    it('refuses an app whose routes disagree', () => {
      const conflicting = [
        { strategy: 'failover', ttl: 60 },
        { strategy: 'roundRobin', ttl: 60 },
      ];
      expect(selector.collapseDeclaredRoutes(conflicting)).to.equal(null);
    });

    it('accepts several routes that agree', () => {
      const agreeing = [
        { strategy: 'roundRobin', ttl: 60 },
        { strategy: 'roundRobin', ttl: 60 },
      ];
      expect(selector.collapseDeclaredRoutes(agreeing))
        .to.deep.equal({ strategy: 'roundRobin', ttl: 60 });
    });
  });
});
