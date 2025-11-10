const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../configLoader');

const router = express.Router();
const configFile = './config.json'; // runtime-writable config file

/*
 * isValidHost(host)
 * ----------------
 * Basic server-side validation for an IPv4 address or DNS hostname. This
 * is intentionally permissive but prevents obvious invalid input when
 * adding/updating Shelly device IPs from the UI.
 */
function isValidHost(host) {
  if (!host || typeof host !== 'string') return false;
  const ipv4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
  const hostname = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*$/;
  return ipv4.test(host) || hostname.test(host);
}

/* Ensure runtime `config.json` exists. If missing, create it from
 * `config.template.json` (recommended) so operators can keep secrets out
 * of the repository. If no template exists, fall back to `config.js`.
 */
if (!fs.existsSync(configFile)) {
  try {
    const templatePath = path.join(__dirname, '..', 'config.template.json');
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, configFile);
    } else {
      // last resort: create from packaged config.js (may include sensitive defaults)
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    }
  } catch (err) {
    console.warn('Could not create config.json from template/config.js:', err.message);
  }
}

/*
 * GET /api/settings
 * ------------------
 * Return runtime-adjustable settings such as watchdog and price fetch
 * intervals and the current Shelly device map. The UI calls this to
 * populate the settings page.
 */
router.get('/settings', (req, res) => {
  // Prefer runtime config file when present
  let runtimeConfig = {};
  try {
    runtimeConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    runtimeConfig = {};
  }
  res.json({
    watchdogInterval: runtimeConfig.watchdogInterval || config.watchdogInterval || 60,
    priceFetchInterval: runtimeConfig.priceFetchInterval || config.priceFetchInterval || 10,
    // Global flag: enable/disable motion-triggered recordings for all cameras
    motionRecordingEnabled: (typeof runtimeConfig.motionRecordingEnabled === 'undefined') ? (typeof config.motionRecordingEnabled === 'undefined' ? true : !!config.motionRecordingEnabled) : !!runtimeConfig.motionRecordingEnabled,
    // Global flag: enable/disable audio recording for all cameras
    audioRecordingEnabled: (typeof runtimeConfig.audioRecordingEnabled === 'undefined') ? (typeof config.audioRecordingEnabled === 'undefined' ? false : !!config.audioRecordingEnabled) : !!runtimeConfig.audioRecordingEnabled,
    // Provide current Shelly device mapping (id -> ip). Prefer runtime config when present.
    shellyDevices: runtimeConfig.shellyDevices || config.shellyDevices || {},
    // Provide video camera definitions to the UI so per-camera controls (e.g. sensitivity)
    videoCameras: runtimeConfig.videoCameras || config.videoCameras || {},
    // Global default motion sensitivity (0-1 or 0-100) used when per-camera value missing
    motionSensitivityDefault: (typeof runtimeConfig.motionSensitivityDefault === 'undefined') ? config.motionSensitivityDefault || 0 : runtimeConfig.motionSensitivityDefault,
    // Global default object types for motion detection filtering
    objectTypesDefault: runtimeConfig.objectTypesDefault || config.objectTypesDefault || ['person', 'vehicle'],
    // User preferences for timezone and locale
    userPreferences: runtimeConfig.userPreferences || {
      timezone: 'Europe/Helsinki',
      locale: 'fi-FI',
      timeFormat: '24h' // '12h' or '24h'
    }
  });
});

/*
 * POST /api/camera-settings
 * -------------------------
 * Persist camera settings including global motionSensitivityDefault and per-camera
 * motionSensitivity overrides into `config.json`.
 */
router.post('/camera-settings', (req, res) => {
  const { motionSensitivityDefault, cameraSettings, objectTypesDefault } = req.body || {};
  if (typeof motionSensitivityDefault === 'undefined' && !cameraSettings && typeof objectTypesDefault === 'undefined') {
    return res.status(400).json({ error: 'Missing motionSensitivityDefault, cameraSettings, or objectTypesDefault' });
  }

  let runtimeConfig = {};
  try { runtimeConfig = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (e) { runtimeConfig = {}; }
  if (!runtimeConfig.videoCameras) runtimeConfig.videoCameras = {};

  try {
    if (typeof motionSensitivityDefault !== 'undefined') {
      runtimeConfig.motionSensitivityDefault = motionSensitivityDefault;
    }
    if (typeof objectTypesDefault !== 'undefined') {
      runtimeConfig.objectTypesDefault = Array.isArray(objectTypesDefault) ? objectTypesDefault : [objectTypesDefault];
    }
    if (cameraSettings && typeof cameraSettings === 'object') {
      for (const [id, settings] of Object.entries(cameraSettings)) {
        if (runtimeConfig.videoCameras[id]) {
          if (typeof settings.motionSensitivity !== 'undefined') {
            runtimeConfig.videoCameras[id].motionSensitivity = settings.motionSensitivity;
          }
          if (settings.objectTypes && Array.isArray(settings.objectTypes)) {
            runtimeConfig.videoCameras[id].objectTypes = settings.objectTypes;
          }
        }
      }
    }
    fs.writeFileSync(configFile, JSON.stringify(runtimeConfig, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to write config.json:', err.message);
    res.status(500).json({ error: 'Failed to persist camera settings' });
  }
});

/*
 * POST /api/settings
 * -------------------
 * Persist updated watchdog and price fetch intervals into runtime
 * `config.json`. This allows changing behavior without restarting the
 * server.
 */
router.post('/settings', (req, res) => {
  const { watchdogInterval, priceFetchInterval, motionRecordingEnabled, audioRecordingEnabled } = req.body;
  if (typeof watchdogInterval === 'undefined' || typeof priceFetchInterval === 'undefined') {
    return res.status(400).send('Missing parameters');
  }

  // Read current runtime config, merge and persist
  let runtimeConfig = {};
  try {
    runtimeConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    runtimeConfig = {};
  }

  runtimeConfig.watchdogInterval = Number(watchdogInterval);
  runtimeConfig.priceFetchInterval = Number(priceFetchInterval);
  // Persist motion recording flag if provided (boolean)
  if (typeof motionRecordingEnabled !== 'undefined') {
    runtimeConfig.motionRecordingEnabled = !!motionRecordingEnabled;
  }
  // Persist audio recording flag if provided (boolean)
  if (typeof audioRecordingEnabled !== 'undefined') {
    runtimeConfig.audioRecordingEnabled = !!audioRecordingEnabled;
  }

  try {
    fs.writeFileSync(configFile, JSON.stringify(runtimeConfig, null, 2));
  } catch (err) {
    console.error('Failed to write config.json:', err.message);
    return res.status(500).send('Failed to persist settings');
  }

  res.send('Settings updated successfully');
});

/*
 * POST /api/shelly
 * -----------------
 * Add a new Shelly device to the runtime `config.json`. Validates the
 * provided hostname/IP and stores the device as an object { name, ip }
 * using a numeric identifier.
 */
router.post('/shelly', (req, res) => {
  const { name, ip } = req.body;
  if (!name || !ip) {
    return res.status(400).send('Missing Shelly name or IP');
  }

  // Optional description field
  const description = req.body.description || '';

  // Validate IP/hostname server-side
  if (!isValidHost(ip)) {
    return res.status(400).send('Invalid IP/hostname');
  }

  // Read current runtime config
  let runtimeConfig = {};
  try {
    runtimeConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    runtimeConfig = {};
  }

  // Ensure shellyDevices is an object mapping id -> ip (preserve mapping style)
  if (!runtimeConfig.shellyDevices) {
    runtimeConfig.shellyDevices = {};
  } else if (Array.isArray(runtimeConfig.shellyDevices)) {
    // Convert array back to object mapping. Array entries may be {name, ip} or plain strings.
    const obj = {};
    let nextIndex = 1;
    for (const item of runtimeConfig.shellyDevices) {
      if (item && typeof item === 'object' && item.name) {
        obj[item.name] = item.ip;
        const n = parseInt(item.name, 10);
        if (!Number.isNaN(n) && n >= nextIndex) nextIndex = n + 1;
      } else if (typeof item === 'string') {
        obj[String(nextIndex)] = item;
        nextIndex++;
      }
    }
    runtimeConfig.shellyDevices = obj;
  }

  // Determine next numeric ID to use (preserve numeric keys when present)
  const existingKeys = Object.keys(runtimeConfig.shellyDevices || {});
  const numericKeys = existingKeys.map(k => parseInt(k, 10)).filter(n => !Number.isNaN(n));
  const nextId = (numericKeys.length > 0 ? Math.max(...numericKeys) + 1 : (existingKeys.length + 1));
  // Store as object {name, ip, description} so UI can show name and description when present
  runtimeConfig.shellyDevices[String(nextId)] = { name: name, ip: ip, description };

  try {
    fs.writeFileSync(configFile, JSON.stringify(runtimeConfig, null, 2));
  } catch (err) {
    console.error('Failed to write config.json:', err.message);
    return res.status(500).send('Failed to persist new Shelly');
  }

  res.send(`Shelly "${name}" added successfully`);
});

/*
 * PUT /api/shelly/:id
 * --------------------
 * Update an existing Shelly entry's name and IP in the runtime config.
 * Overwrites the mapping entry with an object { name, ip } to keep the
 * UI-friendly format.
 */
router.put('/shelly/:id', (req, res) => {
  const { id } = req.params;
  const { name, ip, description } = req.body;
  if (!id || !name || !ip) return res.status(400).send('Missing id, name or ip');

  if (!isValidHost(ip)) {
    return res.status(400).send('Invalid IP/hostname');
  }

  let runtimeConfig = {};
  try {
    runtimeConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    runtimeConfig = {};
  }

  if (!runtimeConfig.shellyDevices) runtimeConfig.shellyDevices = {};
  if (!runtimeConfig.shellyDevices[id]) {
    return res.status(404).send('Device not found');
  }

  // Overwrite with object {name, ip, description} to keep UI-friendly format
  runtimeConfig.shellyDevices[id] = { name: name, ip: ip, description: description || '' };

  try {
    fs.writeFileSync(configFile, JSON.stringify(runtimeConfig, null, 2));
  } catch (err) {
    console.error('Failed to write config.json:', err.message);
    return res.status(500).send('Failed to update Shelly');
  }

  res.send(`Shelly ${id} updated`);
});

/*
 * DELETE /api/shelly/:id
 * -----------------------
 * Remove a Shelly device from the runtime config and also delete any
 * associated persistent settings file (`settings_<id>.json`).
 */
router.delete('/shelly/:id', (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).send('Missing id');
  let runtimeConfig = {};
  try {
    runtimeConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    runtimeConfig = {};
  }
  if (!runtimeConfig.shellyDevices || !runtimeConfig.shellyDevices[id]) {
    return res.status(404).send('Device not found');
  }
  delete runtimeConfig.shellyDevices[id];
  try {
    fs.writeFileSync(configFile, JSON.stringify(runtimeConfig, null, 2));
  } catch (err) {
    console.error('Failed to write config.json:', err.message);
    return res.status(500).send('Failed to remove Shelly');
  }
  // Also remove any persistent settings file for that device (settings_<id>.json)
  try {
    const settingsPath = `./settings_${id}.json`;
    if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
      console.log(`Removed settings file for Shelly ${id}: ${settingsPath}`);
    }
  } catch (err) {
    console.warn(`Failed to remove settings file for Shelly ${id}: ${err.message}`);
    // not fatal — continue
  }
  res.send(`Shelly ${id} removed`);
});

/*
 * POST /api/user-preferences
 * --------------------------
 * Save user preferences including timezone, locale, and time format.
 */
router.post('/user-preferences', (req, res) => {
  const { timezone, locale, timeFormat } = req.body || {};
  
  // Basic validation
  if (timezone && typeof timezone !== 'string') {
    return res.status(400).json({ error: 'Invalid timezone' });
  }
  if (locale && typeof locale !== 'string') {
    return res.status(400).json({ error: 'Invalid locale' });
  }
  if (timeFormat && !['12h', '24h'].includes(timeFormat)) {
    return res.status(400).json({ error: 'Invalid timeFormat - must be "12h" or "24h"' });
  }

  let runtimeConfig = {};
  try {
    runtimeConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    runtimeConfig = {};
  }

  // Initialize userPreferences if it doesn't exist
  if (!runtimeConfig.userPreferences) {
    runtimeConfig.userPreferences = {
      timezone: 'Europe/Helsinki',
      locale: 'fi-FI',
      timeFormat: '24h'
    };
  }

  // Update preferences
  if (timezone !== undefined) runtimeConfig.userPreferences.timezone = timezone;
  if (locale !== undefined) runtimeConfig.userPreferences.locale = locale;
  if (timeFormat !== undefined) runtimeConfig.userPreferences.timeFormat = timeFormat;

  try {
    fs.writeFileSync(configFile, JSON.stringify(runtimeConfig, null, 2));
    res.json({ success: true, userPreferences: runtimeConfig.userPreferences });
  } catch (err) {
    console.error('Failed to write config.json:', err.message);
    return res.status(500).json({ error: 'Failed to save user preferences' });
  }
});

module.exports = router;
