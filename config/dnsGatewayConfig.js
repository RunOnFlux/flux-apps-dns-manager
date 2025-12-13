// DNS Gateway API configuration
// This service uses mTLS for authentication

const endpoint = ''; // DNS Gateway API endpoint (e.g., 'https://dns-gateway.internal:8443')
const certPath = ''; // Path to mTLS client certificate
const keyPath = ''; // Path to mTLS client private key
const caPath = ''; // Path to mTLS CA certificate
const timeout = 30000; // Request timeout in milliseconds
const enabled = false; // Enable or disable DNS Gateway integration

module.exports = {
  endpoint,
  certPath,
  keyPath,
  caPath,
  timeout,
  enabled,
};
