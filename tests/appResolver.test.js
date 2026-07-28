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
    const { selections, unreadable } = await resolveAll([
      legacySpec({ name: 'minecraftone' }),
      { version: 7, name: 'broken' },
      legacySpec({ name: 'minecrafttwo' }),
    ], { gameTypes: GAME_TYPES });

    expect(unreadable).to.deep.equal(['broken']);
    expect(selections.map((s) => s.appName)).to.deep.equal(['minecraftone', 'minecrafttwo']);
  });

  // The distinction the caller acts on. An app we read and did not select is
  // genuinely not ours and its records may eventually be removed; an app we could
  // not read tells us nothing about whether it is still deployed. Collapsing the
  // two would let a decrypt outage age out every sealed app and withdraw its name
  // onto the zone wildcard.
  it('names the apps it could not read, separately from the ones it does not serve', async () => {
    const { selections, unreadable } = await resolveAll([
      legacySpec({ name: 'odoo' }),
      { version: 7, name: 'broken' },
    ], { gameTypes: GAME_TYPES });

    expect(selections).to.deep.equal([]);
    expect(unreadable).to.deep.equal(['broken']);
  });

  it('reports nothing to serve rather than failing on an empty list', async () => {
    const { selections, unreadable } = await resolveAll([], { gameTypes: GAME_TYPES });
    expect(selections).to.deep.equal([]);
    expect(unreadable).to.deep.equal([]);
  });
});
