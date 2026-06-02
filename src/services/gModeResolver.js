const config = require('config');
const fluxApi = require('./fluxApi');
const specDecryptor = require('./specDecryptor');

// Cache the DERIVED answer ("is this a G-mode app?") keyed by the stable spec
// hash - not the spec itself. The hash only changes when the spec changes, so a
// cache hit lets us skip decryption entirely. Caching the boolean (rather than
// the spec) keeps this layer independent of the spec shape, which is expected
// to change in future app versions.
// Map<hash, { isGmode, expiresAt }>
const gModeCache = new Map();

/**
 * @param {Object} spec - Application specification
 * @returns {boolean} True if the spec is an encrypted enterprise spec
 */
function isEnterprise(spec) {
  return spec.version >= 8 && Boolean(spec.enterprise);
}

/**
 * Remove expired entries so the cache stays bounded over time.
 */
function pruneCache() {
  const now = Date.now();
  for (const [hash, entry] of gModeCache) {
    if (entry.expiresAt <= now) gModeCache.delete(hash);
  }
}

/**
 * Determine whether a single app spec is a G-mode app.
 * Enterprise specs are decrypted only on a cache miss; the boolean result is
 * cached by hash. Transient decrypt failures are NOT cached, so they retry.
 * @param {Object} spec - Application specification
 * @returns {Promise<boolean>}
 */
async function classify(spec) {
  const { hash } = spec;

  const cached = hash ? gModeCache.get(hash) : null;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.isGmode;
  }

  let isGmode;
  if (isEnterprise(spec)) {
    if (!specDecryptor.isReady()) {
      // Can't decrypt -> can't classify. Don't cache; retry next loop.
      return false;
    }
    const compose = await specDecryptor.decryptCompose(spec);
    if (!compose) {
      // Transient decrypt failure: don't cache so we retry on the next loop.
      return false;
    }
    // isGModeApp is pure; feed it a throwaway spec carrying the decrypted
    // compose (the input spec is never mutated).
    isGmode = fluxApi.isGModeApp({ ...spec, compose });
  } else {
    // Non-enterprise: compose/containerData is already visible, no decrypt.
    isGmode = fluxApi.isGModeApp(spec);
  }

  // Cache the definitive answer with a random 24-48h TTL (thundering-herd guard).
  if (hash) {
    const ttl = 86_400_000 + Math.floor(Math.random() * 86_400_000);
    gModeCache.set(hash, { isGmode, expiresAt: Date.now() + ttl });
  }
  return isGmode;
}

/**
 * Resolve the names of all G-mode game apps from the full global spec list.
 * Filters by cleartext game-name prefix BEFORE any decryption, so only
 * game-prefixed enterprise apps are ever decrypted (and only on a cache miss).
 * @param {Array} specs - All application specifications
 * @param {string[]} gameTypes - Game name prefixes to match
 * @returns {Promise<string[]>} Names of matching G-mode game apps
 */
async function resolveGameAppNames(specs, gameTypes) {
  pruneCache();

  // Cleartext prefix filter first - avoids touching non-game apps entirely.
  const candidates = specs.filter((spec) => fluxApi.isGameApp(spec.name, gameTypes));

  const names = [];
  const concurrency = config.specDecryptor.concurrency || 5;
  const queue = [...candidates];

  async function worker() {
    while (queue.length) {
      const spec = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      const isGmode = await classify(spec);
      if (isGmode) names.push(spec.name);
    }
  }

  const workerCount = Math.min(concurrency, candidates.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return names;
}

module.exports = {
  resolveGameAppNames,
};
