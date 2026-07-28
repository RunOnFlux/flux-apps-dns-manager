const http = require('http');
const config = require('config');
const app = require('./src/lib/server');
const log = require('./src/lib/log');
const appsDnsManager = require('./src/services/appsDnsManager');

const server = http.createServer(app);

const { port } = config.server;

server.listen(port, () => {
  log.info(`Flux Apps DNS Manager listening on port ${port}`);
  log.info(`DNS Zones: ${config.dns.zones.map((z) => `${z.name} (TTL: ${z.ttl}s)`).join(', ')}`);
  log.info(`Legacy routed names: ${config.games.gameTypes.join(', ')}`);
  log.info(`Polling interval: ${config.games.pollingIntervalMs / 1000}s`);
  log.info(`Deletion grace period: ${config.games.deletionGracePeriodMs / 1000 / 60} minutes`);

  // Start the apps DNS manager. Startup registers the decrypt providers, so a
  // failure here means sealed specs are unreadable — worth surfacing rather than
  // discovering one log line per app on the first sweep.
  appsDnsManager.start().catch((error) => {
    log.error(`Apps DNS Manager failed to start: ${error.message}`);
  });
  log.info('Apps DNS Manager service started');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log.info('SIGTERM received, shutting down gracefully');
  appsDnsManager.stop();
  server.close(() => {
    log.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log.info('SIGINT received, shutting down gracefully');
  appsDnsManager.stop();
  server.close(() => {
    log.info('Server closed');
    process.exit(0);
  });
});
