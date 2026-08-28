const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const axios = require('axios');
const config = require('config');
const log = require('../lib/log');

let api = null;

function sleep(ms) {
  return new Promise((r) => { setTimeout(r, ms); });
}

/**
 * Initialize the mTLS client for enterprise spec decryption
 * @returns {boolean} True if initialized successfully
 */
function initialize() {
  try {
    const {
      keyPath, certPath, caPath, baseUrl, timeoutMs,
    } = config.specDecryptor;

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

  Object.entries(blob).forEach(([key, value]) => {
    if (value instanceof Array) {
      parsed[key] = value.map((item) => (typeof item === 'object' && item !== null ? hydrate(item) : item));
    } else if (value && typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      parsed[key] = parseJson(value);
    } else {
      parsed[key] = value;
    }
  });

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
 * Decrypt a single enterprise app spec and return its compose array.
 * Stateless: performs no caching and does not mutate the input spec. Callers
 * are responsible for caching the result they derive from it.
 * @param {Object} spec - Encrypted enterprise app specification
 * @returns {Promise<Array|null>} Decrypted compose array, or null on failure
 */
/**
 * One attempt at fetching an app's AES key, reduced to the three outcomes the retry loop
 * distinguishes: a key, a refusal that will not change, and "not available, ask again".
 *
 * Takes the client rather than reaching for the module's own, so the retry policy can be
 * exercised without standing up mTLS.
 *
 * @param {Object} client - Decrypt service client
 * @param {string} name - Application name, for logging
 * @param {Object} payload - Decrypt request body
 * @returns {Promise<{key: (string|null), retry: boolean}>}
 */
async function requestAesKey(client, name, payload) {
  const response = await client.post('decryptMessageRSA', payload).catch((err) => {
    log.warn(`Spec decrypt call failed for ${name}: ${err.message}`);
    return null;
  });

  if (!response) return { key: null, retry: true };
  if (response.status !== 200) return { key: null, retry: true };

  const { status: payloadStatus, message: aesKey } = response.data;

  // Made contact but request was rejected
  if (payloadStatus !== 'ok') return { key: null, retry: false };

  if (!aesKey) {
    log.debug(`AES key not found for ${name}`);
    return { key: null, retry: true };
  }

  return { key: aesKey, retry: false };
}

async function decryptCompose(spec) {
  const { enterprise, owner, name } = spec;
  if (!owner || !enterprise) return null;

  const enterpriseBuf = Buffer.from(enterprise, 'base64');
  const aesKeyEncrypted = enterpriseBuf.subarray(0, 256);
  const nonceCiphertextTag = enterpriseBuf.subarray(256);

  const base64EncryptedAesKey = aesKeyEncrypted.toString('base64');

  const payload = {
    fluxID: owner,
    appName: name,
    message: base64EncryptedAesKey,
    blockHeight: 9999999,
  };

  const maxRetries = config.specDecryptor.retries || 4;
  const retryDelayMs = config.specDecryptor.retryDelayMs || 16000;
  let base64AesKey = '';

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await requestAesKey(api, name, payload);

    if (outcome.key) {
      base64AesKey = outcome.key;
      break;
    }

    // Refused rather than unavailable - asking again will not change the answer.
    if (!outcome.retry) return null;

    log.debug(`Decrypt key for ${name} unavailable, retrying in ${retryDelayMs / 1000}s`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(retryDelayMs);
  }

  if (!base64AesKey) return null;

  const decrypted = decryptAesData(name, nonceCiphertextTag, base64AesKey);
  if (!decrypted) return null;

  const parsed = parseJson(decrypted);
  if (!parsed) return null;

  const hydrated = hydrate(parsed);
  log.debug(`Decrypted enterprise app spec: ${name}`);
  return hydrated.compose || null;
}

module.exports = {
  initialize,
  isReady,
  decryptCompose,
  // Exported so the retry policy has a test; not called from outside this module.
  requestAesKey,
};
