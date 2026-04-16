const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const axios = require('axios');
const config = require('config');
const log = require('../lib/log');

let api = null;

// Cache decrypted specs by hash to avoid re-decrypting every poll loop
// Map<hash, { spec, expiresAt }>
const decryptCache = new Map();

function sleep(ms) {
  return new Promise((r) => { setTimeout(r, ms); });
}

/**
 * Initialize the mTLS client for enterprise spec decryption
 * @returns {boolean} True if initialized successfully
 */
function initialize() {
  try {
    const { keyPath, certPath, caPath, baseUrl, timeoutMs } = config.specDecryptor;

    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath) || !fs.existsSync(caPath)) {
      log.error('Spec decryptor certificates not found, enterprise apps will not be processed');
      return false;
    }

    api = axios.create({
      baseURL: baseUrl,
      timeout: timeoutMs,
      httpsAgent: new https.Agent({
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
        ca: fs.readFileSync(caPath),
      }),
    });

    log.info('Spec decryptor initialized successfully');
    return true;
  } catch (error) {
    log.error(`Failed to initialize spec decryptor: ${error.message}`);
    return false;
  }
}

/**
 * @returns {boolean}
 */
function isReady() {
  return api !== null;
}

function parseJson(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * The frontend passes arrays as strings. This recursively parses them back.
 * Ported from FDM dataFetcher.js
 * @param {Object} blob
 * @returns {Object}
 */
function hydrate(blob) {
  const parsed = {};

  for (const [key, value] of Object.entries(blob)) {
    if (value instanceof Array) {
      parsed[key] = value.map((item) => (typeof item === 'object' && item !== null ? hydrate(item) : item));
    } else if (value && typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      parsed[key] = parseJson(value);
    } else {
      parsed[key] = value;
    }
  }

  return parsed;
}

/**
 * Decrypt AES-256-GCM data
 * @param {string} appName
 * @param {Buffer} nonceCiphertextTag
 * @param {string} base64AesKey
 * @returns {string|null}
 */
function decryptAesData(appName, nonceCiphertextTag, base64AesKey) {
  try {
    const key = Buffer.from(base64AesKey, 'base64');

    const nonce = nonceCiphertextTag.subarray(0, 12);
    const ciphertext = nonceCiphertextTag.subarray(12, -16);
    const tag = nonceCiphertextTag.subarray(-16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);

    const decrypted = decipher.update(ciphertext, '', 'utf8') + decipher.final('utf8');

    return decrypted;
  } catch (error) {
    log.error(`Error decrypting AES data for ${appName}: ${error.message}`);
    return null;
  }
}

/**
 * Decrypt a single enterprise app spec
 * @param {Object} appSpec
 * @returns {Promise<Object|null>} Decrypted spec or null on failure
 */
async function decryptAppSpec(appSpec) {
  const spec = appSpec;
  const { enterprise, hash } = spec;

  // Check cache
  const cached = decryptCache.get(hash);
  if (cached && cached.expiresAt > Date.now()) {
    log.debug(`Encrypted app spec ${spec.name} found in cache`);
    return cached.spec;
  }

  const { owner } = spec;
  if (!owner) return null;

  const enterpriseBuf = Buffer.from(enterprise, 'base64');
  const aesKeyEncrypted = enterpriseBuf.subarray(0, 256);
  const nonceCiphertextTag = enterpriseBuf.subarray(256);

  const base64EncryptedAesKey = aesKeyEncrypted.toString('base64');

  const payload = {
    fluxID: owner,
    appName: spec.name,
    message: base64EncryptedAesKey,
    blockHeight: 9999999,
  };

  const maxRetries = config.specDecryptor.retries || 4;
  const retryDelayMs = config.specDecryptor.retryDelayMs || 16000;
  let base64AesKey = '';

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await api.post('decryptMessageRSA', payload).catch((err) => {
      log.warn(`Spec decrypt call failed for ${spec.name}: ${err.message}`);
      return null;
    });

    if (!response) {
      log.debug(`Decrypt key for ${spec.name} failed, retrying in ${retryDelayMs / 1000}s`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(retryDelayMs);
      continue;
    }

    if (response.status !== 200) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(retryDelayMs);
      continue;
    }

    const { status: payloadStatus, message: aesKey } = response.data;

    // Made contact but request was rejected
    if (payloadStatus !== 'ok') return null;

    base64AesKey = aesKey;
    if (base64AesKey) break;

    log.debug(`AES key not found for ${spec.name}, retrying in ${retryDelayMs / 1000}s`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(retryDelayMs);
  }

  if (!base64AesKey) return null;

  const decrypted = decryptAesData(spec.name, nonceCiphertextTag, base64AesKey);
  if (!decrypted) return null;

  const parsed = parseJson(decrypted);
  if (!parsed) return null;

  const hydrated = hydrate(parsed);

  spec.compose = hydrated.compose;
  spec.contacts = hydrated.contacts;
  spec.enterprise = '';

  // Cache with random 24-48h TTL to avoid thundering herd
  const ttl = 86_400_000 + Math.floor(Math.random() * 86_400_000);
  decryptCache.set(hash, { spec, expiresAt: Date.now() + ttl });

  log.info(`Decrypted enterprise app spec: ${spec.name}`);
  return spec;
}

/**
 * Decrypt all enterprise specs from an app spec list (concurrency-limited)
 * Specs are decrypted in-place (compose/contacts populated, enterprise cleared)
 * @param {Array} specs - All app specifications
 * @returns {Promise<Array>} Same specs array with enterprise apps decrypted
 */
async function decryptEnterpriseSpecs(specs) {
  if (!isReady()) {
    log.debug('Spec decryptor not initialized, skipping enterprise decryption');
    return specs;
  }

  const enterpriseSpecs = specs.filter(
    (spec) => spec.version >= 8 && spec.enterprise,
  );

  if (enterpriseSpecs.length === 0) return specs;

  log.info(`Decrypting ${enterpriseSpecs.length} enterprise app specs`);

  const concurrency = config.specDecryptor.concurrency || 5;
  const tasks = enterpriseSpecs.map((spec) => () => decryptAppSpec(spec));

  // Run with concurrency limit (ported from FDM serviceHelper.js)
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = task().finally(() => executing.delete(p));
    executing.add(p);
    results.push(p);
    if (executing.size >= concurrency) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.race(executing);
    }
  }
  const settled = await Promise.allSettled(results);

  let decrypted = 0;
  let failed = 0;
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value) {
      decrypted += 1;
    } else {
      failed += 1;
    }
  }

  log.info(`Enterprise decryption complete: ${decrypted} succeeded, ${failed} failed`);

  return specs;
}

module.exports = {
  initialize,
  isReady,
  decryptEnterpriseSpecs,
};
