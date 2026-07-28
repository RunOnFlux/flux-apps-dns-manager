const { expect } = require('chai');
const specLibs = require('../src/services/specLibs');

// The first tests this service has had. They exist to pin the thing the v9 port
// rests on: that one code path reads every spec version, so the record-writing
// side never asks what version it is looking at.
describe('specLibs', () => {
  function legacySpec(overrides = {}) {
    return {
      version: 7,
      name: 'testapp',
      description: 'test',
      owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
      compose: [{
        name: 'web',
        repotag: 'nginx:latest',
        ports: [31000],
        containerPorts: [80],
        domains: [''],
        environmentParameters: [],
        commands: [],
        containerData: '/data',
        cpu: 0.5,
        ram: 300,
        hdd: 2,
        repoauth: '',
      }],
      instances: 3,
      contacts: [],
      geolocation: [],
      expire: 88000,
      nodes: [],
      staticip: false,
      ...overrides,
    };
  }

  it('deserializes a legacy spec', async () => {
    const spec = await specLibs.deserialize(legacySpec());
    expect(spec.name).to.equal('testapp');
    expect(spec.version).to.equal(7);
  });

  it('resolves a legacy spec to a deployment', async () => {
    const spec = await specLibs.deserialize(legacySpec());
    const deployment = await specLibs.resolveDeployment(spec);
    expect(deployment).to.be.an('object');
  });

  // The load balancer serves haproxy routes and this service serves powerdns ones.
  // A legacy spec synthesizes a route for every port, and every one of them is
  // haproxy — which is precisely why legacy apps cannot be discovered by asking
  // for powerdns routes, and why selection keeps a second path for them.
  it('reports legacy routes as haproxy, and none as powerdns', async () => {
    const spec = await specLibs.deserialize(legacySpec());
    const deployment = await specLibs.resolveDeployment(spec);
    expect(deployment.routes('haproxy')).to.have.lengthOf(1);
    expect(deployment.routes('powerdns')).to.have.lengthOf(0);
  });

  it('marks a cleartext spec as not sealed', async () => {
    expect(await specLibs.isSealed(legacySpec())).to.equal(false);
  });
});
