// What an app's name answers between being registered and the platform knowing where
// it is.
//
// The defect these cover: the name is public from registration, but nothing is
// published for it until an instance is elected ~15 minutes later, and in between the
// zone answers from its wildcard - a director that carries no game traffic - at an
// hour's TTL. Anyone who asks in that window is wrong for an hour.
const { expect } = require('chai');
const config = require('config');
const {
  fakeGateway, fakeFluxApi, fakeZone, install, freshManager, atTime, legacySpec, v9Spec,
} = require('./helpers/fakes');

const [ZONE_CONFIG] = config.dns.zones;
const ZONE = ZONE_CONFIG.name;
const PLACEHOLDER_TTL = ZONE_CONFIG.placeholder.ttl;
const RECORD_TTL = ZONE_CONFIG.ttl;
const GRACE_MS = config.games.deletionGracePeriodMs;
const GAME_PREFIX = config.games.gameTypes[0];

const APP = `${GAME_PREFIX}one`;
const DIRECTOR = 'fdm-lb-1-2.runonflux.io.';
const ELECTED = '87.197.124.197:16127';
const MOVED_TO = '185.17.103.182:16127';
const T0 = 1_800_000_000_000;

// The sweep returns early on an empty spec list, so an app that has gone away is
// modelled by a list that still holds something this service does not serve.
const OTHER_APP = legacySpec({ name: 'notagame', containerData: '/data' });

describe('a name the platform cannot place yet', () => {
  let gateway;
  let zone;
  let restore;
  let manager;

  function setup({
    specs = [], elected = {}, locations = {}, answers = { [APP]: DIRECTOR }, published,
    unreadableZones = false,
  } = {}) {
    gateway = fakeGateway({ published, unreadableZones });
    zone = fakeZone({ answers });
    restore = install({ gateway, api: fakeFluxApi({ specs, elected, locations }), zone });
    manager = freshManager();
  }

  afterEach(() => {
    if (restore) restore();
    restore = null;
  });

  it('is given the answer the zone itself would give, at the placeholder ttl', async () => {
    setup({ specs: [legacySpec({ name: APP })] });

    await manager.runProcessingLoop();

    const stoodIn = gateway.inZone(gateway.placeholdersFor(APP), ZONE);
    expect(stoodIn).to.have.lengthOf(1);
    expect(stoodIn[0].target).to.equal(DIRECTOR);
    expect(stoodIn[0].ttl).to.equal(PLACEHOLDER_TTL);
  });

  it('is stood in for whatever route the owner asked for', async () => {
    // An app that asked to be spread has nowhere to point either, until it is placed.
    setup({ specs: [v9Spec({ name: 'declaredapp', strategy: 'roundRobin' })], answers: { declaredapp: DIRECTOR } });

    await manager.runProcessingLoop();

    expect(gateway.placeholdersFor('declaredapp')).to.have.lengthOf(config.dns.zones.length);
  });

  it('is never given an address, because none is known', async () => {
    setup({ specs: [legacySpec({ name: APP })] });

    await manager.runProcessingLoop();

    expect(gateway.writes).to.have.lengthOf(0);
  });

  it('is stood in for once, not on every sweep', async () => {
    setup({ specs: [legacySpec({ name: APP })] });

    await manager.runProcessingLoop();
    await manager.runProcessingLoop();
    await manager.runProcessingLoop();

    expect(gateway.inZone(gateway.placeholdersFor(APP), ZONE)).to.have.lengthOf(1);
  });

  it('is left alone when the name already answers', async () => {
    // The guard that matters most: a live app whose address the platform has simply
    // stopped reporting. Standing in for it would point players at a proxy.
    setup({
      specs: [legacySpec({ name: APP })],
      published: new Map([[`${APP}@${ZONE}`, { type: 'A', contents: ['87.197.124.197'] }]]),
    });

    await manager.runProcessingLoop();

    expect(gateway.inZone(gateway.placeholdersFor(APP), ZONE)).to.have.lengthOf(0);
  });

  it('publishes nothing at all when the zone cannot be asked', async () => {
    setup({ specs: [legacySpec({ name: APP })], answers: {} });

    await manager.runProcessingLoop();

    expect(gateway.placeholders).to.have.lengthOf(0);
    expect(gateway.writes).to.have.lengthOf(0);
  });

  it('reports what it published, by type', async () => {
    setup({ specs: [legacySpec({ name: APP })] });

    await manager.runProcessingLoop();

    expect(manager.getDNSState()[APP][ZONE]).to.deep.equal({
      type: 'CNAME',
      contents: [DIRECTOR],
    });
  });

  describe('a restart, with the zone already correct', () => {
    // The service keeps what it published in memory only, so on boot it knew nothing
    // and re-asserted every address it manages - PATCHes that change no answer but bump
    // the zone serial and start a transfer to three secondaries, on every deploy.
    it('writes nothing when every record already holds the right address', async () => {
      setup({
        specs: [legacySpec({ name: APP })],
        elected: { [APP]: ELECTED },
        published: new Map(config.dns.zones.map(
          (z) => [`${APP}@${z.name}`, { type: 'A', contents: ['87.197.124.197'] }],
        )),
      });

      await manager.runProcessingLoop();

      expect(gateway.writes).to.have.lengthOf(0);
      expect(gateway.placeholders).to.have.lengthOf(0);
    });

    it('reads each zone once, not once per app', async () => {
      setup({
        specs: [legacySpec({ name: APP }), legacySpec({ name: `${APP}two` })],
        elected: { [APP]: ELECTED, [`${APP}two`]: ELECTED },
      });

      await manager.runProcessingLoop();

      expect(gateway.reads.filter((read) => read.zone === ZONE)).to.have.lengthOf(1);
    });

    it('still writes when the address has actually moved', async () => {
      setup({
        specs: [legacySpec({ name: APP })],
        elected: { [APP]: MOVED_TO },
        published: new Map([[`${APP}@${ZONE}`, { type: 'A', contents: ['87.197.124.197'] }]]),
      });

      await manager.runProcessingLoop();

      const written = gateway.inZone(gateway.writesFor(APP), ZONE);
      expect(written).to.have.lengthOf(1);
      expect(written[0].contents).to.deep.equal(['185.17.103.182']);
    });

    it('finds the record of an app whose name carries capitals', async () => {
      // PowerDNS stores names lower case. Comparing them as the spec writes them had
      // this service read "no record" for a live app - the state in which it stands in.
      const mixed = `${GAME_PREFIX}MixedCase`;
      setup({
        specs: [legacySpec({ name: mixed })],
        answers: { [mixed]: DIRECTOR },
        published: new Map([[`${mixed.toLowerCase()}@${ZONE}`, { type: 'A', contents: ['1.2.3.4'] }]]),
      });

      await manager.runProcessingLoop();

      // Only the one zone was seeded, so assert on that zone: the other legitimately
      // has no record for this name and is stood in for.
      expect(gateway.inZone(gateway.placeholdersFor(mixed), ZONE)).to.have.lengthOf(0);
      expect(gateway.inZone(gateway.writesFor(mixed), ZONE)).to.have.lengthOf(0);
    });

    it('carries on when a zone cannot be read', async () => {
      setup({
        specs: [legacySpec({ name: APP })],
        elected: { [APP]: ELECTED },
        unreadableZones: true,
      });

      await manager.runProcessingLoop();

      // Nothing is known, so it publishes as it would have before: the failure costs a
      // redundant write, never a wrong answer.
      expect(gateway.writesFor(APP).length).to.be.greaterThan(0);
    });
  });

  describe('and then the platform places it', () => {
    it('replaces the placeholder in one transaction rather than two writes', async () => {
      // Two writes cannot work: PowerDNS refuses an A record at a name still carrying a
      // CNAME, and the gap between them would expose the name to the wildcard.
      setup({ specs: [legacySpec({ name: APP })] });
      await manager.runProcessingLoop();

      restore();
      const elected = fakeFluxApi({ specs: [legacySpec({ name: APP })], elected: { [APP]: ELECTED } });
      restore = install({ gateway, api: elected, zone });
      await manager.runProcessingLoop();

      const swaps = gateway.inZone(gateway.swaps, ZONE);
      expect(swaps).to.have.lengthOf(1);
      expect(swaps[0].contents).to.deep.equal(['87.197.124.197']);
      expect(swaps[0].ttl).to.equal(RECORD_TTL);
      expect(gateway.plainWrites).to.have.lengthOf(0);
      expect(gateway.deletes).to.have.lengthOf(0);
    });

    it('uses that same transaction for a first address it has no memory of', async () => {
      // After a restart a placeholder from the previous run may still be published, and
      // a plain write would be refused for as long as it stands.
      setup({ specs: [legacySpec({ name: APP })], elected: { [APP]: ELECTED } });

      await manager.runProcessingLoop();

      expect(gateway.inZone(gateway.swaps, ZONE)).to.have.lengthOf(1);
      expect(gateway.plainWrites).to.have.lengthOf(0);
    });

    it('moves it with a plain replace once an address is published', async () => {
      setup({ specs: [legacySpec({ name: APP })], elected: { [APP]: ELECTED } });
      await manager.runProcessingLoop();

      restore();
      const moved = fakeFluxApi({ specs: [legacySpec({ name: APP })], elected: { [APP]: MOVED_TO } });
      restore = install({ gateway, api: moved, zone });
      await manager.runProcessingLoop();

      const replaced = gateway.inZone(gateway.plainWrites, ZONE);
      expect(replaced).to.have.lengthOf(1);
      expect(replaced[0].contents).to.deep.equal(['185.17.103.182']);
    });
  });

  describe('and then it goes away', () => {
    it('removes the placeholder it published, not an address it never wrote', async () => {
      setup({ specs: [legacySpec({ name: APP })] });

      await atTime(T0, async () => {
        await manager.runProcessingLoop();
      });

      restore();
      restore = install({ gateway, api: fakeFluxApi({ specs: [OTHER_APP] }), zone });

      await atTime(T0, async () => {
        await manager.runProcessingLoop();
      });
      await atTime(T0 + GRACE_MS + 1, async () => {
        await manager.runProcessingLoop();
      });

      const removed = gateway.inZone(gateway.deletesFor(APP), ZONE);
      expect(removed).to.have.lengthOf(1);
      expect(removed[0].recordType).to.equal('CNAME');
    });

    it('removes the address once one was published', async () => {
      setup({ specs: [legacySpec({ name: APP })], elected: { [APP]: ELECTED } });

      await atTime(T0, async () => {
        await manager.runProcessingLoop();
      });

      restore();
      restore = install({ gateway, api: fakeFluxApi({ specs: [OTHER_APP] }), zone });

      await atTime(T0, async () => {
        await manager.runProcessingLoop();
      });
      await atTime(T0 + GRACE_MS + 1, async () => {
        await manager.runProcessingLoop();
      });

      const removed = gateway.inZone(gateway.deletesFor(APP), ZONE);
      expect(removed).to.have.lengthOf(1);
      expect(removed[0].recordType).to.equal('A');
    });
  });
});
