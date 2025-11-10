/*
 * Configuration Manager
 * ---------------------
 * Centralized configuration loading and management to eliminate
 * duplicate config loading logic across modules.
 */

const fs = require('fs');
const path = require('path');

/*
 * loadRuntimeConfig()
 * --------------------
 * Load runtime configuration from config.json or fallback to config.js.
 * This centralizes the config loading logic used by server.js and shellyController.js.
 */
function loadRuntimeConfig() {
  const cfgPath = path.join(__dirname, '..', 'config.json');
  try {
    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    }
  } catch (e) {
    console.warn('Failed to read runtime config.json, falling back to config.js:', e.message);
  }
  // Fallback to static config.js
  try {
    return require('../configLoader');
  } catch (e) {
    console.error('Failed to load config.js fallback:', e.message);
    return {};
  }
}

/*
 * getDevices()
 * ------------
 * Convenience wrapper that returns the `shellyDevices` mapping from the
 * runtime configuration. This is used by various parts of the server and
 * modules to discover available Shelly devices.
 */
function getDevices() {
  const cfg = loadRuntimeConfig();
  return cfg.shellyDevices || {};
}

/*
 * getConfigValue(key)
 * -------------------
 * Get a specific configuration value by key from the runtime config.
 */
function getConfigValue(key) {
  const cfg = loadRuntimeConfig();
  return cfg[key];
}

/*
 * getServerConfig()
 * -----------------
 * Get server-specific configuration values (IP, port, etc.)
 */
function getServerConfig() {
  const cfg = loadRuntimeConfig();
  return {
    SERVER_IP: cfg.SERVER_IP,
    SERVER_PORT: cfg.SERVER_PORT,
    videoCameras: cfg.videoCameras || {}
  };
}

module.exports = {
  loadRuntimeConfig,
  getDevices,
  getConfigValue,
  getServerConfig
};