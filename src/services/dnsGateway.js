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
 * @param {string} zone - DNS zone (required)
 * @param {number} ttl - DNS record TTL in seconds (required)
 * @returns {Promise<object>} DNS Gateway response
 */
async function createGameDNSRecords(appName, serverIPs, zone, ttl) {
  if (!isReady()) {
    throw new Error('DNS Gateway client not initialized or disabled');
  }

  if (!serverIPs || serverIPs.length === 0) {
    throw new Error('No server IPs provided for DNS records');
  }

  if (!zone) {
    throw new Error('DNS zone is required');
  }

  if (!ttl) {
    throw new Error('TTL is required');
  }

  const cleanedIPs = cleanIPs(serverIPs);

  try {
    const response = await dnsGatewayClient.post(`/api/v1/zones/${zone}/records`, {
      name: appName,
      record_type: 'A',
      content: cleanedIPs,
      ttl,
    });

    log.info(`Created DNS records for ${appName}.${zone} -> [${cleanedIPs.join(', ')}]`);
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
 * Publish the placeholder for an app that has no record yet: a CNAME to the same
 * director the zone's wildcard already names, at a TTL of a minute instead of the
 * zone default of an hour.
 *
 * Sent as a single record deliberately, never as part of a batch. PowerDNS refuses a
 * CNAME at a name that already carries an A record, so writing it this way means that
 * if the caller's guard is ever lost, the placeholder is rejected rather than
 * replacing a live app's address with a proxy nobody can play on.
 *
 * @param {string} appName - Application name
 * @param {string} target - Director hostname, fully qualified
 * @param {string} zone - DNS zone (required)
 * @param {number} ttl - DNS record TTL in seconds (required)
 * @returns {Promise<object>} DNS Gateway response
 */
async function createPlaceholderRecord(appName, target, zone, ttl) {
  if (!isReady()) {
    throw new Error('DNS Gateway client not initialized or disabled');
  }

  if (!target) {
    throw new Error('No director target provided for placeholder record');
  }

  if (!zone) {
    throw new Error('DNS zone is required');
  }

  if (!ttl) {
    throw new Error('TTL is required');
  }

  try {
    const response = await dnsGatewayClient.post(`/api/v1/zones/${zone}/records`, {
      name: appName,
      record_type: 'CNAME',
      content: [target],
      ttl,
    });

    log.info(`Published placeholder for ${appName}.${zone} -> ${target} (ttl ${ttl})`);
    return response.data;
  } catch (error) {
    log.error(`Failed to publish placeholder for ${appName}: ${error.message}`);
    if (error.response) {
      log.error(`DNS Gateway response: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

/**
 * Replace an app's placeholder with the address FDM elected, as one transaction.
 *
 * This cannot be done as two calls. PowerDNS refuses to add an A record to a name that
 * still carries a CNAME, so a separate write would fail outright and leave the app on
 * the director permanently; and even if it succeeded, the name would fall back to the
 * zone wildcard in between, at twelve times the TTL of the record being replaced.
 *
 * Removing a CNAME that was never there is a no-op, so this is also the safe form for
 * the first address written for any name whose state this service does not know - after
 * a restart, a placeholder from the previous run may still be published.
 *
 * @param {string} appName - Application name
 * @param {string[]} serverIPs - Array of server IPs for this game
 * @param {string} zone - DNS zone (required)
 * @param {number} ttl - DNS record TTL in seconds (required)
 * @returns {Promise<object>} DNS Gateway response
 */
async function swapPlaceholderForAddresses(appName, serverIPs, zone, ttl) {
  if (!isReady()) {
    throw new Error('DNS Gateway client not initialized or disabled');
  }

  if (!serverIPs || serverIPs.length === 0) {
    throw new Error('No server IPs provided for DNS records');
  }

  if (!zone) {
    throw new Error('DNS zone is required');
  }

  if (!ttl) {
    throw new Error('TTL is required');
  }

  const cleanedIPs = cleanIPs(serverIPs);

  try {
    const response = await dnsGatewayClient.post(`/api/v1/zones/${zone}/records/batch`, {
      operations: [
        { name: appName, record_type: 'CNAME', changetype: 'DELETE' },
        {
          name: appName, record_type: 'A', changetype: 'REPLACE', content: cleanedIPs, ttl,
        },
      ],
    });

    log.info(`Swapped placeholder for ${appName}.${zone} -> [${cleanedIPs.join(', ')}]`);
    return response.data;
  } catch (error) {
    log.error(`Failed to swap placeholder for ${appName}: ${error.message}`);
    if (error.response) {
      log.error(`DNS Gateway response: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

/**
 * Every record published for a name, whatever its type.
 *
 * The published record is the authority on whether a name is already answered - this
 * service's own memory of what it wrote is empty after a restart, and a placeholder
 * must never be published over a record that already exists.
 *
 * @param {string} appName - Application name
 * @param {string} zone - DNS zone (required)
 * @returns {Promise<Array|null>} Records for the name, or null if it has none
 */
async function getRecordsForName(appName, zone) {
  if (!isReady()) {
    throw new Error('DNS Gateway client not initialized or disabled');
  }

  if (!zone) {
    throw new Error('DNS zone is required');
  }

  try {
    const response = await dnsGatewayClient.get(`/api/v1/zones/${zone}/records/${appName}`);
    return (response.data && response.data.records) || null;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return null;
    }
    log.error(`Failed to read records for ${appName}.${zone}: ${error.message}`);
    throw error;
  }
}

/**
 * Delete an app's DNS records
 *
 * @param {string} appName - Application name
 * @param {string} zone - DNS zone (required)
 * @param {string} recordType - Record type to delete; the placeholder is a CNAME, so
 *   removing an app always removes the type that was actually published for it
 * @returns {Promise<void>}
 */
async function deleteGameDNSRecords(appName, zone, recordType = 'A') {
  if (!isReady()) {
    throw new Error('DNS Gateway client not initialized or disabled');
  }

  if (!zone) {
    throw new Error('DNS zone is required');
  }

  try {
    await dnsGatewayClient.delete(`/api/v1/zones/${zone}/records/${appName}/${recordType}`);
    log.info(`Deleted ${recordType} record for ${appName}.${zone}`);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      log.info(`${recordType} record for ${appName}.${zone} not found (already deleted)`);
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
 * @param {string} zone - DNS zone (required)
 * @returns {Promise<object|null>} DNS record data or null if not found
 */
async function getGameDNSRecords(appName, zone) {
  if (!isReady()) {
    throw new Error('DNS Gateway client not initialized or disabled');
  }

  if (!zone) {
    throw new Error('DNS zone is required');
  }

  try {
    const response = await dnsGatewayClient.get(`/api/v1/zones/${zone}/records/${appName}/A`);
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
  createPlaceholderRecord,
  swapPlaceholderForAddresses,
  getRecordsForName,
  deleteGameDNSRecords,
  getGameDNSRecords,
  cleanIPs,
};
