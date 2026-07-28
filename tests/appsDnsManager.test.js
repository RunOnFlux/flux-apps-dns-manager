const { expect } = require('chai');
const config = require('config');
const {
  fakeGateway, fakeFluxApi, install, freshManager, atTime,
} = require('./helpers/fakes');

const ZONES = config.dns.zones.map((z) => z.name);
const GRACE_MS = config.games.deletionGracePeriodMs;
const GAME_PREFIX = config.games.gameTypes[0];

const T0 = 1_800_000_000_000;

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

describe('appsDnsManager sweep', () => {
  let gateway;
  let api;
  let restore;
  let manager;

  function setup({ specs = [], elected = {}, locations = {} } = {}) {
    gateway = fakeGateway();
    api = fakeFluxApi({ specs, elected, locations });
    restore = install({ gateway, api });
    manager = freshManager();
  }

  afterEach(() => {
    if (restore) restore();
    restore = null;
  });

  describe('publishing', () => {
    it('publishes the elected instance for a legacy app, in every zone', async () => {
      setup({
        specs: [legacySpec({ name: `${GAME_PREFIX}one` })],
        elected: { [`${GAME_PREFIX}one`]: '1.2.3.4:16127' },
      });

      await manager.runProcessingLoop();

      const written = gateway.writesFor(`${GAME_PREFIX}one`);
      expect(written.map((w) => w.zone)).to.have.members(ZONES);
      expect(written[0].contents).to.deep.equal(['1.2.3.4']);
    });

    it('gives a legacy app the zone ttl, since its spec carries none', async () => {
      setup({
        specs: [legacySpec({ name: `${GAME_PREFIX}one` })],
        elected: { [`${GAME_PREFIX}one`]: '1.2.3.4:16127' },
      });

      await manager.runProcessingLoop();

      expect(gateway.writes[0].ttl).to.equal(config.dns.zones[0].ttl);
    });

    it('publishes every placement for an app that asked to be spread', async () => {
      setup({
        specs: [v9Spec({ name: 'declaredapp', strategy: 'roundRobin' })],
        locations: { declaredapp: ['1.1.1.1:16127', '2.2.2.2:16137'] },
      });

      await manager.runProcessingLoop();

      expect(gateway.writes[0].contents).to.deep.equal(['1.1.1.1', '2.2.2.2']);
    });

    it('honours a ttl the owner declared', async () => {
      setup({
        specs: [v9Spec({ name: 'declaredapp', strategy: 'roundRobin', ttl: 120 })],
        locations: { declaredapp: ['1.1.1.1:16127'] },
      });

      await manager.runProcessingLoop();

      expect(gateway.writes[0].ttl).to.equal(120);
    });

    // A sweep runs every minute against a fleet that mostly does not move. Rewriting
    // an unchanged record every time would be a write per app per minute, forever.
    it('does not rewrite a record whose addresses have not moved', async () => {
      setup({
        specs: [legacySpec({ name: `${GAME_PREFIX}one` })],
        elected: { [`${GAME_PREFIX}one`]: '1.2.3.4:16127' },
      });

      await manager.runProcessingLoop();
      const afterFirst = gateway.writes.length;
      await manager.runProcessingLoop();

      expect(gateway.writes.length).to.equal(afterFirst);
    });

    it('rewrites when the elected instance moves', async () => {
      setup({
        specs: [legacySpec({ name: `${GAME_PREFIX}one` })],
        elected: { [`${GAME_PREFIX}one`]: '1.2.3.4:16127' },
      });

      await manager.runProcessingLoop();
      api.state.elected[`${GAME_PREFIX}one`] = '9.9.9.9:16127';
      await manager.runProcessingLoop();

      const contents = gateway.writesFor(`${GAME_PREFIX}one`).map((w) => w.contents[0]);
      expect(contents).to.include('9.9.9.9');
    });
  });

  describe('when there is nowhere to point', () => {
    // Withdrawing does not stop the name resolving — the zone wildcard answers with
    // a proxy address the client cannot use, cached far longer than the record. A
    // stale address is the better answer.
    it('publishes nothing and withdraws nothing when no instance is elected', async () => {
      setup({
        specs: [legacySpec({ name: `${GAME_PREFIX}one` })],
        elected: {},
      });

      await manager.runProcessingLoop();

      expect(gateway.writes).to.deep.equal([]);
      expect(gateway.deletes).to.deep.equal([]);
    });

    it('leaves a published record alone when the app stops reporting an instance', async () => {
      setup({
        specs: [legacySpec({ name: `${GAME_PREFIX}one` })],
        elected: { [`${GAME_PREFIX}one`]: '1.2.3.4:16127' },
      });

      await manager.runProcessingLoop();
      api.state.elected = {};
      await manager.runProcessingLoop();

      expect(gateway.deletes).to.deep.equal([]);
    });
  });

  describe('removal', () => {
    // Present in every removal scenario so the network's list is never empty. An
    // empty list means something else entirely — see the guard test below.
    const BYSTANDER = legacySpec({ name: 'unrelatedapp', containerData: '/data' });

    // A sweep that saw nothing would otherwise conclude the entire network had been
    // deleted and, a day later, withdraw every name it manages. An empty response is
    // overwhelmingly more likely to be the API failing than the fleet vanishing.
    it('treats an empty app list as a failed read, not an empty network', async () => {
      setup({
        specs: [legacySpec({ name: `${GAME_PREFIX}one` })],
        elected: { [`${GAME_PREFIX}one`]: '1.2.3.4:16127' },
      });

      await atTime(T0, () => manager.runProcessingLoop());
      api.state.specs = [];
      await atTime(T0 + GRACE_MS + 2000, () => manager.runProcessingLoop());
      await atTime(T0 + (GRACE_MS * 3), () => manager.runProcessingLoop());

      expect(gateway.deletes).to.deep.equal([]);
    });

    it('does not remove an app the moment it leaves the network', async () => {
      setup({
        specs: [legacySpec({ name: `${GAME_PREFIX}one` })],
        elected: { [`${GAME_PREFIX}one`]: '1.2.3.4:16127' },
      });

      await atTime(T0, () => manager.runProcessingLoop());
      api.state.specs = [BYSTANDER];
      await atTime(T0 + 1000, () => manager.runProcessingLoop());

      expect(gateway.deletes).to.deep.equal([]);
    });

    it('removes it from every zone once the grace period has passed', async () => {
      setup({
        specs: [legacySpec({ name: `${GAME_PREFIX}one` })],
        elected: { [`${GAME_PREFIX}one`]: '1.2.3.4:16127' },
      });

      await atTime(T0, () => manager.runProcessingLoop());
      api.state.specs = [BYSTANDER];
      await atTime(T0 + 1000, () => manager.runProcessingLoop());
      await atTime(T0 + GRACE_MS + 2000, () => manager.runProcessingLoop());

      expect(gateway.deletesFor(`${GAME_PREFIX}one`).map((d) => d.zone))
        .to.have.members(ZONES);
    });

    it('cancels a pending removal when the app comes back', async () => {
      const spec = legacySpec({ name: `${GAME_PREFIX}one` });
      setup({ specs: [spec], elected: { [`${GAME_PREFIX}one`]: '1.2.3.4:16127' } });

      await atTime(T0, () => manager.runProcessingLoop());
      api.state.specs = [BYSTANDER];
      await atTime(T0 + 1000, () => manager.runProcessingLoop());
      api.state.specs = [spec];
      await atTime(T0 + 2000, () => manager.runProcessingLoop());
      await atTime(T0 + GRACE_MS + 3000, () => manager.runProcessingLoop());

      expect(gateway.deletes).to.deep.equal([]);
    });

    // The failure this guards against is an outage, not a deployment. If the decrypt
    // service is down, every sealed spec fails to read at once — and if that counted
    // as absence, the whole set would age out and have its names withdrawn onto the
    // wildcard, well past the point the outage ended.
    it('does not age out an app whose spec it cannot read', async () => {
      const good = legacySpec({ name: `${GAME_PREFIX}one` });
      setup({ specs: [good], elected: { [`${GAME_PREFIX}one`]: '1.2.3.4:16127' } });

      await atTime(T0, () => manager.runProcessingLoop());

      // Still listed by the network, but now unreadable.
      api.state.specs = [{ version: 7, name: `${GAME_PREFIX}one` }];
      await atTime(T0 + 1000, () => manager.runProcessingLoop());
      await atTime(T0 + GRACE_MS + 2000, () => manager.runProcessingLoop());

      expect(gateway.deletes).to.deep.equal([]);
    });

    // The counterpart: read cleanly and genuinely no longer ours, which is a real
    // change of intent rather than an absence of information.
    it('ages out an app that is readable but no longer serves DNS', async () => {
      setup({
        specs: [legacySpec({ name: `${GAME_PREFIX}one` })],
        elected: { [`${GAME_PREFIX}one`]: '1.2.3.4:16127' },
      });

      await atTime(T0, () => manager.runProcessingLoop());

      // Same app, marker dropped — it no longer replicates active-standby.
      api.state.specs = [legacySpec({ name: `${GAME_PREFIX}one`, containerData: '/data' })];
      await atTime(T0 + 1000, () => manager.runProcessingLoop());
      await atTime(T0 + GRACE_MS + 2000, () => manager.runProcessingLoop());

      expect(gateway.deletesFor(`${GAME_PREFIX}one`).map((d) => d.zone))
        .to.have.members(ZONES);
    });
  });

  describe('reported state', () => {
    it('lists the apps it is managing', async () => {
      setup({
        specs: [legacySpec({ name: `${GAME_PREFIX}one` })],
        elected: { [`${GAME_PREFIX}one`]: '1.2.3.4:16127' },
      });

      await manager.runProcessingLoop();

      expect(manager.getStatus().managedApps).to.deep.equal([`${GAME_PREFIX}one`]);
      expect(manager.getDNSState()[`${GAME_PREFIX}one`][ZONES[0]]).to.deep.equal(['1.2.3.4']);
    });
  });
});
