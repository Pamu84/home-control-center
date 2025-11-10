const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const axios = require('axios');
const { turnOnShelly, turnOffShelly, clearOverride, getShellyStatus, handleHeartbeat, getDevices, deviceStatus } = require('../../shellyController');
const { loadRuntimeConfig } = require('../../config/manager');

// pushState keeps per-device push metadata to avoid hammering devices
// and to apply exponential backoff when pushes fail.
const pushState = {}; // id -> { lastAttempt: ms, backoffMs: ms }

// NOTE: previously this module attempted to POST a refreshConfig action
// directly to devices when settings changed. That behaviour caused
// connection-reset log noise and a UI-driven "Force Refresh" flow which
// the user requested to remove. The server now relies on the device-pull
// model (devices fetch /api/config/:id) and does not nudge devices here.

module.exports = function createShellyModule(deps = {}) {
  const router = express.Router();

  /*
   * computeSchedule(prices, settings)
   * ---------------------------------
   * Build a boolean schedule array for a day (24h) divided into slots according
   * to `settings.timeFrame`. The function calculates averaged prices per period,
   * picks the `numCheapest` periods, and applies `minPrice`/`maxPrice` overrides.
   * - prices: flat array of numbers (expected 96 for 15min slots)
   * - settings: object with { minPrice, maxPrice, numCheapest, timeFrame }
   * Returns: schedule array (length depends on timeFrame mapping but callers
   * expect 96 boolean slots for 15min). This is used by the /api/config/:id
   * endpoint to send schedules to Shelly devices.
   */
  function computeSchedule(prices, settings) {
    const { minPrice, maxPrice, numCheapest, timeFrame } = settings;
    // canonical unit is 15-minute slots: 96 slots per day
    const slotsPerPeriod = timeFrame === '30min' ? 2 : timeFrame === '1hour' ? 4 : 1;
    const periodsPerDay = 96 / slotsPerPeriod; // 48 for 30min, 24 for 1hour, 96 for 15min

    // Calculate average price per period (period = timeframe window)
    const periodAverages = [];
    for (let p = 0; p < periodsPerDay; p++) {
      let sum = 0, count = 0;
      const startIdx = p * slotsPerPeriod;
      const endIdx = startIdx + slotsPerPeriod;
      for (let j = startIdx; j < endIdx && j < prices.length; j++) {
        sum += prices[j];
        count++;
      }
      periodAverages.push({ price: count > 0 ? sum / count : 9999, index: p });
    }

    // Sort to find cheapest periods
    periodAverages.sort((a, b) => a.price - b.price);

    // Create canonical 96-slot schedule (boolean per 15-min slot)
    const schedule = Array(96).fill(false);

    // Mark numCheapest periods as true
    for (let i = 0; i < numCheapest && i < periodAverages.length; i++) {
      const pIdx = periodAverages[i].index;
      const startSlot = pIdx * slotsPerPeriod;
      const endSlot = startSlot + slotsPerPeriod;
      for (let s = startSlot; s < endSlot && s < schedule.length; s++) schedule[s] = true;
    }

    // Apply minPrice/maxPrice overrides per period
    for (let p = 0; p < periodsPerDay; p++) {
      let sum = 0, count = 0;
      const startIdx = p * slotsPerPeriod;
      const endIdx = startIdx + slotsPerPeriod;
      for (let j = startIdx; j < endIdx && j < prices.length; j++) { sum += prices[j]; count++; }
      const avgPrice = count > 0 ? sum / count : 9999;
      if (avgPrice < minPrice) {
        for (let s = startIdx; s < endIdx && s < schedule.length; s++) schedule[s] = true;
      } else if (avgPrice > maxPrice) {
        for (let s = startIdx; s < endIdx && s < schedule.length; s++) schedule[s] = false;
      }
    }

    return schedule;
  }

  // Build the same config payload that /api/config/:id returns so the
  // server can push it directly to the device.
  function buildConfigForDevice(id) {
    // Load price data
    let prices = [];
    try {
      const priceCache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'prices.json'), 'utf8'));
      prices = [...(priceCache.today || []).map(p => p.price), ...(priceCache.tomorrow || []).map(p => p.price)];
    } catch (error) {
      console.warn('Module(shelly): Price cache unavailable when building pushed config:', error.message);
    }

    // Load settings
    const filePath = path.join(__dirname, '..', '..', `settings_${id}.json`);
    let settings = {
      minPrice: 0.05,
      maxPrice: 0.20,
      numCheapest: 4,
      timeFrame: '15min',
      manualOverride: false,
      manualState: null,
      reversedControl: false,
      fallbackHours: Array(24).fill(false)
    };
    if (fs.existsSync(filePath)) {
      try { settings = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { console.warn('Module(shelly): failed to read settings when building pushed config:', e.message); }
    }
    if (typeof settings.reversedControl === 'undefined') settings.reversedControl = false;

    // Compute schedule using local computeSchedule
    let schedule;
    if (settings.manualOverride) {
      if (settings.manualState === 'off') schedule = Array(96).fill(false);
      else if (settings.manualState === 'on') schedule = Array(96).fill(true);
      else schedule = computeSchedule(prices, settings);
    } else {
      schedule = computeSchedule(prices, settings);
    }

    // Get user timezone from config
    const runtimeConfig = loadRuntimeConfig();
    const userTimezone = runtimeConfig.userPreferences?.timezone || 'Europe/Helsinki';

    const config = {
      deviceId: id,
      minPrice: Number(settings.minPrice),
      maxPrice: Number(settings.maxPrice),
      numCheapest: Number(settings.numCheapest),
      timeFrame: settings.timeFrame,
      manualOverride: !!settings.manualOverride,
      manualState: settings.manualState || null,
      reversedControl: !!settings.reversedControl,
      fallbackHours: settings.fallbackHours || Array(24).fill(false),
      prices: prices.length > 0 ? prices.slice(0, 96) : Array(96).fill(0),
      schedule: schedule,
      serverTime: new Date().toISOString(),
      serverSlot: (function() { 
        const now = new Date();
        // Use UTC for slot calculation to match device behavior
        return now.getUTCHours() * 4 + Math.floor(now.getUTCMinutes() / 15);
      })(),
      lastUpdated: new Date().toISOString()
    };
    return config;
  }

  async function tryPushConfigToDevice(id) {
    try {
      const devices = getDevices();
      const entry = devices[id];
      let ip = null;
      if (entry) ip = typeof entry === 'object' ? entry.ip : String(entry);
      if (!ip) return;

      const now = Date.now();
      const state = pushState[id] || { lastAttempt: 0, backoffMs: 0 };
      const cooldown = state.backoffMs || 2000; // default 2s
      if (now - (state.lastAttempt || 0) < cooldown) {
        console.log(`Module(shelly): skipping pushConfig for ${id}, cooling down (${Math.round((cooldown - (now - state.lastAttempt))/1000)}s left)`);
        return;
      }

      state.lastAttempt = now;
      const config = buildConfigForDevice(id);
      try {
        // Try a sequence of endpoints to reliably trigger device refresh
        // without causing POST resets. Order:
        // 1) GET /script/<id>/notify (lightweight, triggers device pull)
        // 2) GET /notify (legacy / alternative path)
        // 3) GET /rpc/Shelly.Refresh (firmware RPC that often succeeds)
        // 4) POST /script/<id>/control with applyConfig (last-resort)

        const tryNotify = async (url, timeoutMs) => {
          try {
            const r = await axios.get(url, { timeout: timeoutMs });
            if (r && r.status === 200) return { ok: true, resp: r };
            return { ok: false, resp: r };
          } catch (err) {
            return { ok: false, err };
          }
        };

        // 1) Script notify
  // Devices host the Shelly Script under /script/1/... (id is constant in the path)
  const scriptNotify = `http://${ip}/script/1/notify?ts=${Date.now()}`;
        let outcome = await tryNotify(scriptNotify, 4000);
        if (outcome.ok) {
          console.log(`Module(shelly): notify sent to device ${id} at ${ip} (script path)`);
          state.backoffMs = 0; pushState[id] = state; return;
        }

        // 2) Legacy notify path (some setups use /notify)
        const legacyNotify = `http://${ip}/notify?ts=${Date.now()}`;
        outcome = await tryNotify(legacyNotify, 3000);
        if (outcome.ok) {
          console.log(`Module(shelly): notify sent to device ${id} at ${ip} (legacy path)`);
          state.backoffMs = 0; pushState[id] = state; return;
        }

        // 3) Try firmware RPC to trigger a refresh. This often bypasses
        // custom HTTP handlers that reject POSTs. Use GET on the RPC path.
        try {
          const rpcUrl = `http://${ip}/rpc/Shelly.Refresh`;
          const r = await axios.get(rpcUrl, { timeout: 4000 });
          if (r && r.status === 200) {
            console.log(`Module(shelly): triggered firmware RPC refresh for ${id} at ${ip}`);
            state.backoffMs = 0; pushState[id] = state; return;
          }
        } catch (rpcErr) {
          const code = rpcErr && rpcErr.code ? ` (${rpcErr.code})` : '';
          // Do NOT attempt POST fallback; POSTs caused connection resets on some devices.
          console.log(`Module(shelly): notify+RPC failed for ${id} at ${ip}${code} — will apply backoff`);
          // Bubble error to outer catch which applies exponential backoff.
          throw rpcErr;
        }
      } catch (e) {
        const prev = state.backoffMs || 2000;
        const next = Math.min(prev ? prev * 2 : 2000, 300000); // cap at 5min
        state.backoffMs = next;
        pushState[id] = state;
        const code = e && e.code ? ` (${e.code})` : '';
        const status = e && e.response && e.response.status ? ` status=${e.response.status}` : '';
        const rdata = e && e.response && e.response.data ? ` data=${JSON.stringify(e.response.data).substring(0,200)}` : '';
        console.log(`Module(shelly): pushConfig failed for ${id} at ${ip}${code}${status} — applying backoff ${Math.round(next/1000)}s ${rdata}`);
        return;
      }
    } catch (e) {
      console.log(`Module(shelly): unexpected error when pushing config for ${id}:`, e && e.message ? e.message : e);
    }
  }

  /*
   * GET /api/config/:id
   * --------------------
   * Endpoint Shelly devices call to fetch their configuration. Responds with
   * device-level settings, the computed `schedule`, the current `prices`
   * (first 96 slots) and server-provided `serverTime`/`serverSlot` which the
   * device script can use if its RTC is wrong. This endpoint is the main
   * contract consumed by `shellyScript.js` running on physical devices.
   */
  router.get('/api/config/:id', async (req, res) => {
    const { id } = req.params;
    console.log(`Module(shelly) Received config request for Shelly ${id}`);
    const devices = getDevices();
    if (!devices[id]) {
      console.error(`Unknown Shelly device: ${id}`);
      return res.status(404).json({ error: `Unknown Shelly device: ${id}` });
    }
    try {
      const config = buildConfigForDevice(id);
      res.json(config);
    } catch (error) {
      console.error(`Module(shelly) Failed to generate config for Shelly ${id}:`, error.message);
      res.status(500).json({ error: `Failed to generate config: ${error.message}` });
    }
  });

  /*
   * POST /api/heartbeat/:id
   * ------------------------
   * Receives periodic heartbeats from a Shelly device. The payload is
   * forwarded to `handleHeartbeat` in `shellyController` which updates the
   * in-memory `deviceStatus` and notification state. Returns status.ok or
   * error depending on whether the device ID is known.
   */
  router.post('/api/heartbeat/:id', (req, res) => {
    const { id } = req.params;
    const result = handleHeartbeat(id, req.body);
    res.status(result.status === "ok" ? 200 : 400).json(result);
  });

  /*
   * GET /api/status
   * ----------------
   * Returns the aggregated `deviceStatus` object maintained by
   * `shellyController`. This includes online/lastHeartbeat/lastPrice and is
   * used by the UI to show device health and last-known metrics.
   */
  router.get('/api/status', (req, res) => {
    res.json(deviceStatus);
  });

  /*
   * POST /api/control
   * ------------------
   * External control endpoint used by the UI and by internal reconcile
   * logic. Accepts { id, action } where action is 'on'|'off'|'clear'. Reads
   * per-device `settings_<id>.json` to honor `reversedControl` before
   * issuing the effective physical action via `shellyController`.
   */
  router.post('/api/control', async (req, res) => {
    const { id, action } = req.body;
    try {
      // Read device settings to respect reversedControl flag
      const settingsPath = path.join(__dirname, '..', '..', `settings_${id}.json`);
      let settings = {};
      try {
        if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch (e) {
        console.warn(`Module(shelly): failed to read settings for ${id} when applying control: ${e.message}`);
      }

      let effectiveAction = action;
      if (action === 'on' || action === 'off') {
        if (settings && settings.reversedControl) {
          // invert action when reversedControl is enabled
          effectiveAction = action === 'on' ? 'off' : 'on';
        }
      }

      if (effectiveAction === 'on') {
        await turnOnShelly(id);
      } else if (effectiveAction === 'off') {
        await turnOffShelly(id);
      } else if (action === 'clear') {
        // clear should not be inverted; it's a logical reset
        await clearOverride(id);
      } else {
        throw new Error('Invalid action');
      }
  res.json({ success: true, message: `Shelly ${id} requested ${action}, performed ${effectiveAction}` });
    } catch (error) {
      console.error(`Module(shelly) Control error for Shelly ${id} (${action}):`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  /*
   * POST /api/save-settings
   * ------------------------
   * Persist device settings sent from the UI into `settings_<id>.json`.
   * Ensures backward compatibility by setting default flags (e.g.
   * `reversedControl`) when missing.
   */
  router.post('/api/save-settings', (req, res) => {
    const { id, settings } = req.body;
    if (!id || !settings) return res.status(400).json({ error: 'Invalid id or settings' });
    try {
      const filePath = path.join(__dirname, '..', '..', `settings_${id}.json`);
      // Ensure reversedControl exists when saving
      if (typeof settings.reversedControl === 'undefined') settings.reversedControl = false;
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
  // Push new config to device so server has control as primary source.
  // The push is best-effort: failures will apply backoff and device will
  // still pick up config on its own schedule.
  tryPushConfigToDevice(id);
      res.json({ success: true });
    } catch (error) {
      console.error(`Module(shelly) Failed to save settings for ${id}:`, error.message);
      res.status(500).json({ error: `Save failed: ${error.message}` });
    }
  });

  /*
   * GET /api/load-settings?id=<id>
   * -------------------------------
   * Returns saved settings for a device or defaults if none exist. The UI
   * calls this to populate the settings form for a Shelly device.
   */
  router.get('/api/load-settings', (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    try {
      const filePath = path.join(__dirname, '..', '..', `settings_${id}.json`);
      if (fs.existsSync(filePath)) {
        const settings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        res.json(settings);
      } else {
        res.json({
          minPrice: 0.05,
          maxPrice: 0.20,
          numCheapest: 4,
          timeFrame: '15min',
          manualOverride: false,
          manualState: null,
          reversedControl: false
        });
      }
    } catch (error) {
      console.error(`Module(shelly) Failed to load settings for ${id}:`, error.message);
      res.status(500).json({ error: `Load failed: ${error.message}` });
    }
  });

  /*
   * GET /api/shelly-status/:id
   * ---------------------------
   * On-demand RPC-style status check for a given Shelly device. This will
   * call into `getShellyStatus` which queries the device's RPC endpoint and
   * returns structured device info useful for diagnostics.
   */
  router.get('/api/shelly-status/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const status = await getShellyStatus(id);
      res.json(status);
    } catch (error) {
      console.error(`Module(shelly) Error fetching status for Shelly ${id}:`, error.message);
      res.status(500).json({ error: `Failed to get status: ${error.message}` });
    }
  });

  /*
   * POST /api/sync-rules
   * ---------------------
   * Persist new rule-set for device `id` and touch the deviceStatus.lastSync
   * timestamp so UIs and devices can detect the change. This is used when
   * rules need to be pushed programmatically to devices.
   */
  router.post('/api/sync-rules', (req, res) => {
    const { id, rules } = req.body;
    if (!id || !rules) return res.status(400).json({ error: 'Invalid id or rules' });
    const devices = getDevices();
    if (!devices[id]) return res.status(404).json({ error: `Unknown Shelly device: ${id}` });
    try {
      const filePath = path.join(__dirname, '..', '..', `settings_${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(rules, null, 2));
  if (!deviceStatus[id]) deviceStatus[id] = {};
  deviceStatus[id].lastSync = new Date().toISOString();
  // Best-effort push to device with backoff
  tryPushConfigToDevice(id);

  res.json({ success: true, message: `Rules synced for Shelly ${id}` });
    } catch (error) {
      console.error(`Module(shelly) Failed to sync rules for Shelly ${id}:`, error.message);
      res.status(500).json({ error: `Failed to sync rules: ${error.message}` });
    }
  });

  /*
   * GET /api/get-script?id=<id>
   * ----------------------------
   * Return the repository `shellyScript.js` patched so the `deviceId`
   * property matches the requested `id`. This is used by the UI to show
   * the script for manual upload into the Shelly device.
   */
  router.get('/api/get-script', (req, res) => {
    const id = req.query && req.query.id ? String(req.query.id) : null;
    if (!id) return res.status(400).json({ success: false, error: 'Missing id query parameter' });
    // Read local script and patch deviceId to match the requested id so the
    // operator can copy/paste it to the Shelly device without manual edits.
    const scriptPath = path.join(__dirname, '..', '..', 'shellyScript.js');
    let scriptBody = '';
    try {
      scriptBody = fs.readFileSync(scriptPath, 'utf8');
    } catch (e) {
      console.error('Get-script: failed to read local shellyScript.js:', e.message);
      return res.status(500).json({ success: false, error: 'Failed to read local shellyScript.js' });
    }
    // Determine runtime server address (prefer runtime config.json then packaged config.js)
    let runtimeCfg = {};
    try {
      const cfgPath = path.join(__dirname, '..', '..', 'config.json');
      if (fs.existsSync(cfgPath)) {
        runtimeCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {};
      } else {
        runtimeCfg = require(path.join(__dirname, '..', '..', 'config')) || {};
      }
    } catch (e) {
      try { runtimeCfg = require(path.join(__dirname, '..', '..', 'config')); } catch (e2) { runtimeCfg = {}; }
    }

    var serverIp = runtimeCfg.SERVER_IP || runtimeCfg.serverIp || runtimeCfg.server || runtimeCfg.host || '127.0.0.1';
    var serverPort = runtimeCfg.SERVER_PORT || runtimeCfg.serverPort || runtimeCfg.port || 3000;
    var serverUrl = 'http://' + serverIp + ':' + serverPort;

    // Replace the first occurrence of deviceId: "..." and serverUrl: "..."
    var patched = scriptBody.replace(/deviceId:\s*"[^"]*"/, 'deviceId: "' + id + '"');
    patched = patched.replace(/serverUrl:\s*"[^"]*"/, 'serverUrl: "' + serverUrl + '"');
    return res.json({ success: true, script: patched, patchedServerUrl: serverUrl });
  });

  /*
   * POST /api/reconcile/:id
   * ------------------------
   * Compute the desired logical state for the current 15-minute slot (using
   * saved settings and `prices.json`) and, unless `manualOverride` is
   * enabled, instruct the device to match the physical relay to that state.
   * This endpoint is useful for on-demand reconciliation and testing.
   */
  router.post('/api/reconcile/:id', async (req, res) => {
    const { id } = req.params;
    const devices = getDevices();
    if (!devices[id]) return res.status(404).json({ error: `Unknown Shelly device: ${id}` });
    try {
      // Load settings
      const settingsPath = path.join(__dirname, '..', '..', `settings_${id}.json`);
      let settings = {};
      if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

      // If manual override is active, do not reconcile
      if (settings.manualOverride) return res.status(200).json({ success: false, message: 'Manual override active; reconciliation skipped' });

      // Load prices
      let prices = [];
      try {
        const priceCache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'prices.json'), 'utf8'));
        prices = [...(priceCache.today || []).map(p => p.price), ...(priceCache.tomorrow || []).map(p => p.price)];
      } catch (err) {
        console.warn('Reconcile: failed to load prices.json:', err.message);
      }

      // Compute schedule for today (96 slots)
      const schedule = computeSchedule(prices, { ...settings, timeFrame: settings.timeFrame || '15min' });

      // Determine current slot (UTC-based 15-min slot)
      const now = new Date();
      const slot = now.getUTCHours() * 4 + Math.floor(now.getUTCMinutes() / 15);
      const shouldBeOn = !!schedule[slot];

      // Respect reversedControl when issuing the physical command
      const physShouldBeOn = settings.reversedControl ? !shouldBeOn : shouldBeOn;

      // Fetch device status to see current physical state
      const status = await getShellyStatus(id);
      const currentlyOn = !!status.switchOn;

      if (currentlyOn === physShouldBeOn) {
        return res.json({ success: true, message: 'Already in desired state', currentlyOn, physShouldBeOn, shouldBeOn, reversedControl: !!settings.reversedControl });
      }

  // Issue control
  if (physShouldBeOn) await turnOnShelly(id);
  else await turnOffShelly(id);

  return res.json({ success: true, message: 'Reconciliation performed', previouslyOn: currentlyOn, nowOn: physShouldBeOn, shouldBeOn, reversedControl: !!settings.reversedControl });
    } catch (error) {
      console.error(`Reconcile failed for Shelly ${id}:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });

  /*
   * Periodic status checks
   * -----------------------
   * Every minute query each runtime Shelly device via RPC to refresh the
   * `deviceStatus` records. This keeps the UI and reconcile logic up-to-date
   * without waiting for device heartbeats.
   */
  cron.schedule('*/1 * * * *', async () => {
    console.log('Module(shelly) Checking Shelly statuses (runtime devices)...');
    const devices = getDevices();
    for (const id of Object.keys(devices)) {
      try {
        await getShellyStatus(id);
      } catch (e) {
        console.warn(`Module(shelly) Status check failed for Shelly ${id}:`, e.message);
      }
    }
  });

  // Periodically push full config to devices (best-effort). This ensures
  // devices receive updated server-driven config even if no UI action was
  // taken. Use a 5-minute cadence to avoid excessive network load.
  cron.schedule('*/5 * * * *', async () => {
    console.log('Module(shelly) Periodic push of config to runtime devices...');
    const devices = getDevices();
    for (const id of Object.keys(devices)) {
      try {
        await tryPushConfigToDevice(id);
      } catch (e) {
        console.warn(`Module(shelly) Periodic push failed for ${id}:`, e && e.message ? e.message : e);
      }
    }
  });

  return { router, publicPath: path.join(__dirname, 'public'), manifest: require('./manifest.json') };
};

