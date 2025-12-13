const axios = require('axios');
const https = require('https');
const fs = require('fs');
const config = require('config');
const log = require('../lib/log');

let dnsGatewayClient = null;

/**
 * Initialize the DNS Gateway client with mTLS authentication
 * Must be called before using any DNS operations
 */
function initializeClient() {
  if (!config.dnsGateway.enabled) {
    log.warn('DNS Gateway is disabled in configuration');
    return false;
  }

  if (!config.dnsGateway.endpoint) {
    log.error('DNS Gateway endpoint not configured');
    return false;
  }

  try {
    const httpsAgent = new https.Agent({
      cert: fs.readFileSync(config.dnsGateway.certPath),
      key: fs.readFileSync(config.dnsGateway.keyPath),
      ca: fs.readFileSync(config.dnsGateway.caPath),
      rejectUnauthorized: true,
    });

    dnsGatewayClient = axios.create({
      baseURL: config.dnsGateway.endpoint,
      timeout: config.dnsGateway.timeout,
      httpsAgent,
    });

    log.info('DNS Gateway client initialized successfully');
    return true;
  } catch (error) {
    log.error(`Failed to initialize DNS Gateway client: ${error.message}`);
    return false;
  }
}

/**
 * Check if the DNS Gateway client is ready
 * @returns {boolean}
 */
function isReady() {
  return dnsGatewayClient !== null && config.dnsGateway.enabled;
}

/**
 * Clean IP addresses - remove port numbers and IPv6 brackets
 * @param {string[]} ips - Array of IP addresses
 * @returns {string[]} Cleaned IP addresses
 */
function cleanIPs(ips) {
  return ips.map((ip) => {
    const cleanIP = ip.split(':')[0]; // Remove port
    return cleanIP.replace(/\[|\]/g, ''); // Remove IPv6 brackets
  });
}

/**
 * Create or update DNS A records for a game app
 * Creates multiple A records (one for each IP) for round-robin DNS load balancing
 *
 * @param {string} appName - Application name (e.g., 'minecraft-abc123')
 * @param {string[]} serverIPs - Array of server IPs for this game
 * @param {string} zone - DNS zone (default: from config)
 * @returns {Promise<object>} DNS Gateway response
 */
async function createGameDNSRecords(appName, serverIPs, zone = null) {
  if (!isReady()) {
    throw new Error('DNS Gateway client not initialized or disabled');
  }

  if (!serverIPs || serverIPs.length === 0) {
    throw new Error('No server IPs provided for DNS records');
  }

  const dnsZone = zone || config.dns.zone;
  const cleanedIPs = cleanIPs(serverIPs);

  try {
    const response = await dnsGatewayClient.post(`/api/v1/zones/${dnsZone}/records`, {
      name: appName,
      record_type: 'A',
      content: cleanedIPs,
      ttl: config.dns.ttl,
    });

    log.info(`Created DNS records for ${appName}.${dnsZone} -> [${cleanedIPs.join(', ')}]`);
    return response.data;
  } catch (error) {
    log.error(`Failed to create DNS records for ${appName}: ${error.message}`);
    if (error.response) {
      log.error(`DNS Gateway response: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

/**
 * Delete DNS A records for a game app
 *
 * @param {string} appName - Application name
 * @param {string} zone - DNS zone
 * @returns {Promise<void>}
 */
async function deleteGameDNSRecords(appName, zone = null) {
  if (!isReady()) {
    throw new Error('DNS Gateway client not initialized or disabled');
  }

  const dnsZone = zone || config.dns.zone;

  try {
    await dnsGatewayClient.delete(`/api/v1/zones/${dnsZone}/records/${appName}/A`);
    log.info(`Deleted DNS records for ${appName}.${dnsZone}`);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      log.info(`DNS records for ${appName}.${dnsZone} not found (already deleted)`);
      return;
    }
    log.error(`Failed to delete DNS records for ${appName}: ${error.message}`);
    throw error;
  }
}

/**
 * Get DNS A records for a game app
 *
 * @param {string} appName - Application name
 * @param {string} zone - DNS zone
 * @returns {Promise<object|null>} DNS record data or null if not found
 */
async function getGameDNSRecords(appName, zone = null) {
  if (!isReady()) {
    throw new Error('DNS Gateway client not initialized or disabled');
  }

  const dnsZone = zone || config.dns.zone;

  try {
    const response = await dnsGatewayClient.get(`/api/v1/zones/${dnsZone}/records/${appName}/A`);
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return null;
    }
    log.error(`Failed to get DNS records for ${appName}: ${error.message}`);
    throw error;
  }
}

module.exports = {
  initializeClient,
  isReady,
  createGameDNSRecords,
  deleteGameDNSRecords,
  getGameDNSRecords,
  cleanIPs,
};
