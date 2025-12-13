const http = require('http');
const config = require('config');
const app = require('./src/lib/server');
const log = require('./src/lib/log');
const appsDnsManager = require('./src/services/appsDnsManager');

const server = http.createServer(app);

const { port } = config.server;

server.listen(port, () => {
  log.info(`Flux Apps DNS Manager listening on port ${port}`);
  log.info(`DNS Zone: ${config.dns.zone}`);
  log.info(`Game types: ${config.games.gameTypes.join(', ')}`);
  log.info(`Polling interval: ${config.games.pollingIntervalMs / 1000}s`);
  log.info(`Deletion grace period: ${config.games.deletionGracePeriodMs / 1000 / 60} minutes`);

  // Start the apps DNS manager
  appsDnsManager.start();
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
