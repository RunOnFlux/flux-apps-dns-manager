// The mTLS identity this service uses to read sealed app specs. It holds its own
// key, certificate and CA, so spec access never goes through another service.
//
// The opening itself belongs to flux-spec's decrypt lifecycle; this module builds
// the transport and registers the version-specific providers on it, after which a
// sealed spec of any version opens through `spec.decrypt()` with nothing here
// knowing which version it was.
const fs = require('fs');
const https = require('https');
const axios = require('axios');
const config = require('config');
const log = require('../lib/log');
const { registerSpecDecryptProviders } = require('./specCrypto');

let api = null;

/**
 * Build the mTLS client and register the decrypt providers.
 * @returns {Promise<boolean>} True if initialized successfully
 */
async function initialize() {
  try {
    const {
      keyPath, certPath, caPath, baseUrl, timeoutMs, retries, retryDelayMs,
    } = config.specDecryptor;

    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath) || !fs.existsSync(caPath)) {
      log.error('Spec decryptor certificates not found, encrypted apps will not be processed');
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

    await registerSpecDecryptProviders({
      http: api,
      endpoints: {
        rsaDecrypt: config.cryptoService.rsaDecryptPath,
        gcmDecrypt: config.cryptoService.gcmDecryptPath,
      },
      retries: { attempts: retries || 4, delayMs: retryDelayMs || 16000 },
    });

    log.info('Spec decryptor initialized successfully');
    return true;
  } catch (error) {
    log.error(`Failed to initialize spec decryptor: ${error.message}`);
    api = null;
    return false;
  }
}

/**
 * @returns {boolean}
 */
function isReady() {
  return api !== null;
}

module.exports = {
  initialize,
  isReady,
};
