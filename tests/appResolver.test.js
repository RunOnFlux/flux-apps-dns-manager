const { expect } = require('chai');
const { resolveAll } = require('../src/services/appResolver');

const GAME_TYPES = ['minecraft'];

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

describe('appResolver', () => {
  it('keeps only the apps this service serves', async () => {
    const { selections } = await resolveAll([
      legacySpec({ name: 'minecraftflux' }),
      legacySpec({ name: 'odoo' }),
    ], { gameTypes: GAME_TYPES });

    expect(selections.map((s) => s.appName)).to.deep.equal(['minecraftflux']);
  });

  // The reason this loop has a per-spec guard at all: the network's spec list is
  // not ours and one unreadable entry in it must not stop DNS being maintained
  // for every other app.
  it('skips a spec it cannot read without abandoning the sweep', async () => {
    const { selections, skipped } = await resolveAll([
      legacySpec({ name: 'minecraftone' }),
      { version: 7, name: 'broken' },
      legacySpec({ name: 'minecrafttwo' }),
    ], { gameTypes: GAME_TYPES });

    expect(skipped).to.equal(1);
    expect(selections.map((s) => s.appName)).to.deep.equal(['minecraftone', 'minecrafttwo']);
  });

  it('reports nothing to serve rather than failing on an empty list', async () => {
    const { selections, skipped } = await resolveAll([], { gameTypes: GAME_TYPES });
    expect(selections).to.deep.equal([]);
    expect(skipped).to.equal(0);
  });
});
