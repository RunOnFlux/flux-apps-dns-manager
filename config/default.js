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
  // DNS configuration with zone-specific FDM settings
  dns: {
    zones: [
      // {
      //   name: 'app.runonflux.io',
      //   ttl: 300,
      //   fdm: {
      //     baseUrlPattern: 'http://fdm-fn-1-{index}.runonflux.io:16130',
      //     serverCount: 4,
      //     timeout: 10000,
      //   },
      // },
      {
        name: 'app2.runonflux.io',
        ttl: 300,
        fdm: {
          baseUrlPattern: 'http://fdm-fn-2-{index}.runonflux.io:16130',
          serverCount: 2,
          timeout: 10000,
        },
      },
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
