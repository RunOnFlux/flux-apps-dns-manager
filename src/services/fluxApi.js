const axios = require('axios');
const config = require('config');
const log = require('../lib/log');

const axiosConfig = {
  timeout: config.fluxApi.timeout,
};

/**
 * Get the FDM index (1-4) based on the first letter of the app name
 * - a-g -> 1
 * - h-n -> 2
 * - o-u -> 3
 * - v-z -> 4
 * @param {string} appName - Application name
 * @returns {number} FDM index (1-4)
 */
function getFdmIndex(appName) {
  const firstLetter = appName.substring(0, 1).toLowerCase();
  if (firstLetter.match(/[h-n]/)) {
    return 2;
  }
  if (firstLetter.match(/[o-u]/)) {
    return 3;
  }
  if (firstLetter.match(/[v-z]/)) {
    return 4;
  }
  return 1; // a-g or any other character
}

/**
 * Get the FDM base URL for a specific app
 * @param {string} appName - Application name
 * @returns {string} FDM base URL
 */
function getFdmBaseUrl(appName) {
  const index = getFdmIndex(appName);
  return config.fdm.baseUrlPattern.replace('{index}', index);
}

/**
 * Get the master IP for an app from FDM's /appips endpoint
 * This returns the IP(s) currently configured in HAProxy for the app
 * @param {string} appName - Application name
 * @returns {Promise<string|null>} The master IP or null if not available
 */
async function getAppMasterIpFromFdm(appName) {
  const fdmBaseUrl = getFdmBaseUrl(appName);
  const url = `${fdmBaseUrl}/appips/${appName}`;

  try {
    const response = await axios.get(url, { timeout: config.fdm.timeout });

    if (response.data.status === 'success' && response.data.data) {
      const { ips } = response.data.data;
      if (ips && ips.length > 0) {
        // Return the first IP (strip port if present)
        const ip = ips[0].split(':')[0];
        log.debug(`FDM returned IP ${ip} for app ${appName}`);
        return ip;
      }
    }

    log.warn(`No IPs returned from FDM for app ${appName}`);
    return null;
  } catch (error) {
    if (error.response && error.response.status === 503) {
      log.debug(`FDM service starting up for app ${appName}, will retry later`);
    } else if (error.response && error.response.status === 404) {
      log.debug(`App ${appName} not found in FDM`);
    } else {
      log.error(`Failed to get master IP from FDM for ${appName}: ${error.message}`);
    }
    return null;
  }
}

/**
 * Get all application specifications from the Flux network
 * @returns {Promise<Array>} Array of app specifications
 */
async function getAppSpecifications() {
  try {
    const url = `${config.fluxApi.baseUrl}/apps/globalappsspecifications`;
    const response = await axios.get(url, axiosConfig);
    if (response.data.status === 'success') {
      return response.data.data || [];
    }
    log.warn(`Unexpected response from getAppSpecifications: ${response.data.status}`);
    return [];
  } catch (error) {
    log.error(`Failed to fetch app specifications: ${error.message}`);
    return [];
  }
}

/**
 * Get location (IP addresses) for a specific application
 * @param {string} appName - Application name
 * @returns {Promise<Array>} Array of location objects with ip property
 */
async function getApplicationLocation(appName) {
  try {
    const url = `${config.fluxApi.baseUrl}/apps/location/${appName}`;
    const response = await axios.get(url, { timeout: 5000 });
    if (response.data.status === 'success') {
      return response.data.data || [];
    }
    log.warn(`Unexpected response from getApplicationLocation for ${appName}: ${response.data.status}`);
    return [];
  } catch (error) {
    log.error(`Failed to get app location for ${appName}: ${error.message}`);
    return [];
  }
}

/**
 * Get all application locations in batch
 * @returns {Promise<Map<string, Array>>} Map of appName -> locations
 */
async function getAllApplicationLocations() {
  try {
    const url = `${config.fluxApi.baseUrl}/apps/locations`;
    const response = await axios.get(url, axiosConfig);
    if (response.data.status === 'success') {
      const locations = new Map();
      const data = response.data.data || [];
      for (const app of data) {
        if (app.name && app.locations) {
          locations.set(app.name, app.locations);
        }
      }
      return locations;
    }
    log.warn(`Unexpected response from getAllApplicationLocations: ${response.data.status}`);
    return new Map();
  } catch (error) {
    log.error(`Failed to fetch all app locations: ${error.message}`);
    return new Map();
  }
}

/**
 * Check if an app specification is G-mode (has g: in containerData)
 * G-mode apps are single-instance apps that need master selection
 * @param {Object} appSpec - Application specification
 * @returns {boolean}
 */
function isGModeApp(appSpec) {
  if (appSpec.version <= 3) {
    return appSpec.containerData && appSpec.containerData.includes('g:');
  }
  // Composed app - check all components
  if (appSpec.compose) {
    return appSpec.compose.some(
      (component) => component.containerData && component.containerData.includes('g:'),
    );
  }
  return false;
}

/**
 * Check if an app name matches any of the game type prefixes
 * @param {string} appName - Application name
 * @param {string[]} gameTypes - Array of game type prefixes
 * @returns {boolean}
 */
function isGameApp(appName, gameTypes) {
  const lowerName = appName.toLowerCase();
  for (const gameType of gameTypes) {
    if (lowerName.startsWith(gameType.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Filter app specifications to get only G-mode game apps
 * @param {Array} appSpecs - All application specifications
 * @param {string[]} gameTypes - Array of game type prefixes to match
 * @returns {Array} Filtered game app specifications
 */
function filterGameApps(appSpecs, gameTypes) {
  return appSpecs.filter((app) => {
    // Must be a G-mode app
    if (!isGModeApp(app)) {
      return false;
    }
    // Must match a game type prefix
    if (!isGameApp(app.name, gameTypes)) {
      return false;
    }
    return true;
  });
}

module.exports = {
  getAppSpecifications,
  getApplicationLocation,
  getAllApplicationLocations,
  getAppMasterIpFromFdm,
  getFdmIndex,
  getFdmBaseUrl,
  isGModeApp,
  isGameApp,
  filterGameApps,
};
