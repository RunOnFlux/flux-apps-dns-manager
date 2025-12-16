const dnsGatewayConfig = require('./dnsGatewayConfig');
const gamesConfig = require('./gamesConfig');

module.exports = {
  server: {
    port: 16140,
  },
  // Flux API endpoints
  fluxApi: {
    baseUrl: 'https://api.runonflux.io',
    timeout: 30000,
  },
  // FDM (Flux Domain Manager) API endpoints
  fdm: {
    // Base URL pattern - {index} will be replaced with 1-4 based on app name
    baseUrlPattern: 'https://fdm-fn-1-{index}.runonflux.io',
    timeout: 10000,
  },
  // DNS configuration
  dns: {
    zones: [
      { name: 'app.runonflux.io', ttl: 300 },
      { name: 'app2.runonflux.io', ttl: 300 },
    ],
  },
  // DNS Gateway configuration (mTLS authenticated)
  dnsGateway: {
    endpoint: dnsGatewayConfig.endpoint,
    certPath: dnsGatewayConfig.certPath,
    keyPath: dnsGatewayConfig.keyPath,
    caPath: dnsGatewayConfig.caPath,
    timeout: dnsGatewayConfig.timeout,
    enabled: dnsGatewayConfig.enabled,
  },
  // Game apps configuration
  games: {
    // Game type prefixes to match (case-insensitive prefix matching)
    gameTypes: gamesConfig.gameTypes,
    // Polling interval for checking game apps (ms)
    // 60s is reasonable since DNS TTL is 300s and IP changes are infrequent
    pollingIntervalMs: 60000,
    // Grace period before deleting DNS records for removed apps (ms)
    // Protects against accidental deletion during service restart or API issues
    deletionGracePeriodMs: 60 * 60 * 1000, // 1 hour
  },
};
