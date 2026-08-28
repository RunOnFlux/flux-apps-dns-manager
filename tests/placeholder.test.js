// What a game app's name answers between being registered and being elected.
//
// The defect these cover: the name is public from registration, but nothing is
// published for it until FDM elects an instance ~15 minutes later, and in between the
// zone answers from its wildcard - a director that carries no game traffic - at an
// hour's TTL. Anyone who asks in that window is wrong for an hour.
const { expect } = require('chai');
const config = require('config');
const {
  fakeGateway, fakeFluxApi, fakeZone, install, freshManager, atTime, gameSpec,
} = require('./helpers/fakes');

const [ZONE_CONFIG] = config.dns.zones;
const ZONE = ZONE_CONFIG.name;
const PLACEHOLDER_TTL = ZONE_CONFIG.placeholder.ttl;
const RECORD_TTL = ZONE_CONFIG.ttl;
const GRACE_MS = config.games.deletionGracePeriodMs;

const APP = 'palworldtest';
const DIRECTOR = 'fdm-lb-1-3.runonflux.io.';
const ELECTED = '87.197.124.197';
const MOVED_TO = '185.17.103.182';
const T0 = 1_800_000_000_000;

// The sweep returns early on an empty spec list, so an app that has gone away is
// modelled by a list that still has something in it - just not the game.
const OTHER_APP = gameSpec({ name: 'nginxthing', containerData: '/data' });

/**
 * Run `cycles` sweeps against one set of fakes and hand back the gateway's record of
 * what it was asked to do.
 */
async function sweep({
  specs = [], elected = {}, answers = { [APP]: DIRECTOR }, published, cycles = 1, manager,
  unreadableZones = false,
}) {
  const gateway = fakeGateway({ published, unreadableZones });
  const api = fakeFluxApi({ specs, elected });
  const zone = fakeZone({ answers });
  const restore = install({ gateway, api, zone });
  const service = manager || freshManager();
  try {
    for (let i = 0; i < cycles; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await service.runProcessingLoop();
    }
  } finally {
    restore();
  }
  return { gateway, zone, service };
}

describe('a name with nothing published for it', () => {
  it('is given the answer the zone itself would give, at the placeholder ttl', async () => {
    const { gateway } = await sweep({ specs: [gameSpec({ name: APP })] });

    const stoodIn = gateway.inZone(gateway.placeholders, ZONE);
    expect(stoodIn).to.have.lengthOf(1);
    expect(stoodIn[0].target).to.equal(DIRECTOR);
    expect(stoodIn[0].ttl).to.equal(PLACEHOLDER_TTL);
  });

  it('is never given an address, because none is known', async () => {
    const { gateway } = await sweep({ specs: [gameSpec({ name: APP })] });

    expect(gateway.writes).to.have.lengthOf(0);
    expect(gateway.swaps).to.have.lengthOf(0);
  });

  it('asks the zone what it answers, rather than working it out', async () => {
    const { zone } = await sweep({ specs: [gameSpec({ name: APP })] });

    expect(zone.asked.map((a) => a.zone)).to.include(ZONE);
  });

  it('is stood in for once, not on every sweep', async () => {
    const { gateway } = await sweep({ specs: [gameSpec({ name: APP })], cycles: 3 });

    expect(gateway.inZone(gateway.placeholders, ZONE)).to.have.lengthOf(1);
  });

  it('reports what it published, by type', async () => {
    const { service } = await sweep({ specs: [gameSpec({ name: APP })] });

    expect(service.getDNSState()[APP][ZONE]).to.deep.equal({
      type: 'CNAME',
      contents: [DIRECTOR],
    });
  });
});

describe('a name that already answers', () => {
  it('is never replaced by a placeholder', async () => {
    // The guard that matters most: this is a live app whose address FDM has simply
    // stopped reporting. Standing in for it would point players at a proxy.
    const published = new Map([[`${APP}@${ZONE}`, { type: 'A', contents: [ELECTED] }]]);

    const { gateway } = await sweep({ specs: [gameSpec({ name: APP })], published });

    expect(gateway.inZone(gateway.placeholders, ZONE)).to.have.lengthOf(0);
  });

  it('is checked against what is published, not against memory alone', async () => {
    // Memory is empty after a restart, so the zone is what decides.
    const { gateway } = await sweep({ specs: [gameSpec({ name: APP })] });

    expect(gateway.reads.filter((read) => read.zone === ZONE)).to.have.lengthOf(1);
  });
});

describe('a restart, with the zone already correct', () => {
  // The defect this covers: the service keeps what it published in memory only, so on
  // boot it knew nothing and re-asserted every address it manages. Each of those is a
  // PATCH that changes no answer but bumps the zone serial and starts a transfer to
  // three secondaries - hundreds of them, on every deploy.
  it('writes nothing when every record already holds the right address', async () => {
    const { gateway } = await sweep({
      specs: [gameSpec({ name: APP })],
      elected: { [APP]: ELECTED },
      published: new Map([
        [`${APP}@${ZONE}`, { type: 'A', contents: [ELECTED] }],
        [`${APP}@${config.dns.zones[1].name}`, { type: 'A', contents: [ELECTED] }],
      ]),
    });

    expect(gateway.writes).to.have.lengthOf(0);
    expect(gateway.swaps).to.have.lengthOf(0);
    expect(gateway.placeholders).to.have.lengthOf(0);
  });

  it('reads each zone once, not once per app', async () => {
    const { gateway } = await sweep({
      specs: [gameSpec({ name: APP }), gameSpec({ name: `${APP}two` })],
      elected: { [APP]: ELECTED, [`${APP}two`]: ELECTED },
    });

    expect(gateway.reads.filter((read) => read.zone === ZONE)).to.have.lengthOf(1);
  });

  it('still writes when the address has actually moved', async () => {
    const { gateway } = await sweep({
      specs: [gameSpec({ name: APP })],
      elected: { [APP]: MOVED_TO },
      published: new Map([[`${APP}@${ZONE}`, { type: 'A', contents: [ELECTED] }]]),
    });

    const written = gateway.inZone(gateway.writes, ZONE);
    expect(written).to.have.lengthOf(1);
    expect(written[0].contents).to.deep.equal([MOVED_TO]);
  });

  it('finds the record of an app whose name carries capitals', async () => {
    // PowerDNS stores names lower case. Comparing them as written by the spec had this
    // service conclude a live app had no record at all - which is exactly the state in
    // which it would stand in for one.
    const mixed = 'MinecraftServerMixedCase';
    const { gateway } = await sweep({
      specs: [gameSpec({ name: mixed })],
      answers: { [mixed]: DIRECTOR },
      published: new Map([[`${mixed.toLowerCase()}@${ZONE}`, { type: 'A', contents: [ELECTED] }]]),
    });

    expect(gateway.inZone(gateway.placeholders, ZONE)).to.have.lengthOf(0);
    expect(gateway.inZone(gateway.writes, ZONE)).to.have.lengthOf(0);
  });

  it('carries on when a zone cannot be read', async () => {
    const { gateway } = await sweep({
      specs: [gameSpec({ name: APP })],
      elected: { [APP]: ELECTED },
      unreadableZones: true,
    });

    // Nothing is known, so it publishes as it would have before - the failure costs a
    // redundant write, never a wrong answer.
    expect(gateway.writes.length + gateway.swaps.length).to.be.greaterThan(0);
  });
});

describe('when the zone cannot be asked', () => {
  it('publishes nothing at all, leaving the wildcard exactly as it was', async () => {
    const { gateway } = await sweep({ specs: [gameSpec({ name: APP })], answers: {} });

    expect(gateway.placeholders).to.have.lengthOf(0);
    expect(gateway.writes).to.have.lengthOf(0);
    expect(gateway.swaps).to.have.lengthOf(0);
  });
});

describe('when FDM elects an instance', () => {
  it('replaces the placeholder in one transaction rather than two writes', async () => {
    // Two writes cannot work: PowerDNS refuses an A record at a name still carrying a
    // CNAME, and the gap between them would expose the name to the wildcard.
    const specs = [gameSpec({ name: APP })];
    const { gateway, service } = await sweep({ specs });
    await sweep({
      specs, elected: { [APP]: ELECTED }, manager: service,
    }).then(({ gateway: second }) => {
      const swaps = second.inZone(second.swaps, ZONE);
      expect(swaps).to.have.lengthOf(1);
      expect(swaps[0].contents).to.deep.equal([ELECTED]);
      expect(swaps[0].ttl).to.equal(RECORD_TTL);
      expect(second.writes).to.have.lengthOf(0);
      expect(second.deletes).to.have.lengthOf(0);
    });
    expect(gateway.inZone(gateway.placeholders, ZONE)).to.have.lengthOf(1);
  });

  it('uses that same transaction for a first address it has no memory of', async () => {
    // After a restart a placeholder from the previous run may still be published, and
    // a plain write would be refused for as long as it stands.
    const { gateway } = await sweep({
      specs: [gameSpec({ name: APP })],
      elected: { [APP]: ELECTED },
    });

    expect(gateway.inZone(gateway.swaps, ZONE)).to.have.lengthOf(1);
    expect(gateway.writes).to.have.lengthOf(0);
  });

  it('moves a master with a plain replace once an address is published', async () => {
    const specs = [gameSpec({ name: APP })];
    const { service } = await sweep({ specs, elected: { [APP]: ELECTED } });
    const { gateway } = await sweep({ specs, elected: { [APP]: MOVED_TO }, manager: service });

    const moves = gateway.inZone(gateway.writes, ZONE);
    expect(moves).to.have.lengthOf(1);
    expect(moves[0].contents).to.deep.equal([MOVED_TO]);
    expect(gateway.swaps).to.have.lengthOf(0);
  });

  it('does not rewrite an address that has not changed', async () => {
    const specs = [gameSpec({ name: APP })];
    const { service } = await sweep({ specs, elected: { [APP]: ELECTED } });
    const { gateway } = await sweep({ specs, elected: { [APP]: ELECTED }, manager: service });

    expect(gateway.writes).to.have.lengthOf(0);
    expect(gateway.swaps).to.have.lengthOf(0);
  });
});

describe('when an app goes away', () => {
  it('removes the placeholder it published, not an address it never wrote', async () => {
    const service = freshManager();
    await atTime(T0, async () => {
      await sweep({ specs: [gameSpec({ name: APP })], manager: service });
      // Gone: the first sweep without it starts the grace period.
      await sweep({ specs: [OTHER_APP], manager: service });
    });

    let gateway;
    await atTime(T0 + GRACE_MS + 1, async () => {
      ({ gateway } = await sweep({ specs: [OTHER_APP], manager: service }));
    });

    const removed = gateway.inZone(gateway.deletes, ZONE);
    expect(removed).to.have.lengthOf(1);
    expect(removed[0].recordType).to.equal('CNAME');
  });

  it('removes the address once one was published', async () => {
    const service = freshManager();
    await atTime(T0, async () => {
      await sweep({ specs: [gameSpec({ name: APP })], elected: { [APP]: ELECTED }, manager: service });
      await sweep({ specs: [OTHER_APP], manager: service });
    });

    let gateway;
    await atTime(T0 + GRACE_MS + 1, async () => {
      ({ gateway } = await sweep({ specs: [OTHER_APP], manager: service }));
    });

    const removed = gateway.inZone(gateway.deletes, ZONE);
    expect(removed).to.have.lengthOf(1);
    expect(removed[0].recordType).to.equal('A');
  });
});
