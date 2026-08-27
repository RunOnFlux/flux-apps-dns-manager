const { expect } = require('chai');
const { resolveAll, resolveOne } = require('../src/services/appResolver');
const specLibs = require('../src/services/specLibs');
const { registerSpecDecryptProviders } = require('../src/services/specCrypto');

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

  // Registering a provider against a version's class makes one available to be
  // built; it is not applied on its own. A sealed spec opened without being handed
  // one is refused, so the sealed stand-in below refuses in exactly that way rather
  // than accepting whatever this code happens to do. Encoding the assumption instead
  // would have let the whole sealed corpus fail while the suite stayed green.
  describe('opening a sealed spec', () => {
    let restore;

    function sealedStandIn() {
      const calls = { createProvider: 0, decryptedWith: undefined };
      const opened = {
        components: {},
        routes: () => [],
      };
      return {
        calls,
        opened,
        doc: { version: 9, name: 'sealedapp' },
        spec: {
          async createProvider() {
            calls.createProvider += 1;
            return { marker: 'provider' };
          },
          async decrypt(provider) {
            if (!provider) throw new Error('decrypt requires a CryptoProvider instance');
            calls.decryptedWith = provider;
            return opened;
          },
        },
      };
    }

    afterEach(() => {
      if (restore) restore();
      restore = null;
    });

    // Returns what resolveDeployment was handed, which is how we check the opened
    // spec is classified rather than the sealed one it came from.
    function stubLibs(sealed) {
      const seen = { resolved: undefined };
      const realDeserialize = specLibs.deserialize;
      const realResolve = specLibs.resolveDeployment;
      specLibs.deserialize = async () => sealed.spec;
      specLibs.resolveDeployment = async (s) => {
        seen.resolved = s;
        return { components: {}, routes: () => [] };
      };
      restore = () => {
        specLibs.deserialize = realDeserialize;
        specLibs.resolveDeployment = realResolve;
      };
      return seen;
    }

    it('builds a provider and hands it to decrypt', async () => {
      const sealed = sealedStandIn();
      stubLibs(sealed);

      await resolveOne(sealed.doc, { gameTypes: GAME_TYPES });

      expect(sealed.calls.createProvider).to.equal(1);
      expect(sealed.calls.decryptedWith).to.deep.equal({ marker: 'provider' });
    });

    it('classifies the opened spec, not the sealed one', async () => {
      const sealed = sealedStandIn();
      const seen = stubLibs(sealed);

      await resolveOne(sealed.doc, { gameTypes: GAME_TYPES });

      expect(seen.resolved).to.equal(sealed.opened);
    });
  });

  // The two tests above stand in for flux-spec on both sides — what they prove is
  // this module's orchestration, and they would stay green if a real decrypted spec
  // could not be resolved at all. So one case drives the real thing end to end: a
  // genuinely sealed v9 document, opened through the registered provider, resolved by
  // the real DeploymentSpec, and read by the real selector.
  //
  // A decrypted spec is an object and has no wire form — flux-spec refuses to
  // serialize one — so this is also the assertion that the resolver never needs to
  // turn it back into a document.
  describe('a real sealed spec, end to end', () => {
    const OWNER = '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1';
    let sealedDoc;

    before(async () => {
      const { FluxAppSpecV9, EncryptedSpecV9, CryptoProvider } = await specLibs.load();

      const cleartext = FluxAppSpecV9.fromSubmission({
        version: 9,
        name: 'sealedgame',
        description: 'x',
        owner: OWNER,
        ttl: 2592000,
        contacts: { email: ['a@b.com'] },
        instances: 1,
        components: {
          game: {
            name: 'game',
            description: 'x',
            image: 'itzg/minecraft-server:latest',
            cpu: 0.5,
            memory: 300,
            rootFsGb: 2,
            persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
            ports: { game: { containerPort: 25565, hostPort: 31000 } },
            // Values chosen to differ from the powerdns defaults (failover / 60), so
            // the assertions below can only pass by reading the decrypted spec.
            loadBalancing: { game: { provider: 'powerdns', strategy: 'roundRobin', ttl: 120 } },
          },
        },
      });

      // The stub keeps the plaintext the real decrypt service would hand back.
      class StubEncrypt extends CryptoProvider {
        async encrypt(plaintext) {
          this.captured = plaintext;
          return {
            algorithm: 'AES-256-GCM', ciphertext: 'Y3Q=', nonce: 'bm9uY2U=', tag: 'dGFn',
          };
        }
      }
      const encryptStub = new StubEncrypt();
      sealedDoc = (await EncryptedSpecV9.fromSpec(cleartext, encryptStub)).serialize();

      // The real provider registration over a stub transport — the same call the
      // decryptor makes, so what opens the spec here is what opens it in production.
      await registerSpecDecryptProviders({
        http: { post: async () => ({ status: 200, data: { status: 'ok', message: encryptStub.captured.toString('base64') } }) },
        endpoints: { rsaDecrypt: 'decryptMessageRSA', gcmDecrypt: 'v2/decrypt' },
        retries: { attempts: 1, delayMs: 0 },
      });
    });

    it('is genuinely sealed before it is opened', async () => {
      expect(await specLibs.isSealed(sealedDoc)).to.equal(true);
    });

    it('selects the app from the decrypted spec, reading the route the owner declared', async () => {
      const selection = await resolveOne(sealedDoc, { gameTypes: GAME_TYPES });

      expect(selection).to.not.equal(null);
      expect(selection.appName).to.equal('sealedgame');
      expect(selection.source).to.equal('declared');
      expect(selection.strategy).to.equal('roundRobin');
      expect(selection.ttl).to.equal(120);
    });

    it('resolves a deployment straight from the decrypted spec, with no document in between', async () => {
      const { EncryptedSpecV9 } = await specLibs.load();
      const spec = await specLibs.deserialize(sealedDoc);
      expect(spec).to.be.instanceOf(EncryptedSpecV9);

      const decrypted = await spec.decrypt(await spec.createProvider());
      expect(decrypted.sealed, 'contents readable').to.equal(false);
      expect(() => decrypted.spec.serialize(), 'and no wire form to fall back on').to.throw(/no wire form/);

      const deployment = await specLibs.resolveDeployment(decrypted);
      expect(deployment.routes('powerdns').map((r) => r.strategy)).to.deep.equal(['roundRobin']);
    });
  });
});
