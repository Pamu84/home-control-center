const express = require('express');
const fs = require('fs');
const path = require('path');
const { fetchEnergyPrices } = require('./energyPrices');
const cron = require('node-cron');
const { applyShellyControl } = require('./controlLogic');
const { loadRuntimeConfig, getDevices, getServerConfig } = require('./config/manager');
const { SERVER_IP, SERVER_PORT, videoCameras } = getServerConfig();
const settingsRoutes = require('./routes/settings');
const { ffmpeg, ffmpegAvailable } = require('./utils/ffmpeg');
const { createChildLogger } = require('./utils/logger');
const { deviceStatus } = require('./shellyController');

const logger = createChildLogger('server');
const app = express();

app.use(express.static(path.join(__dirname, 'public')));
// Parse JSON for API endpoints and also parse raw SDP offers as text
app.use(express.json());
app.use(express.text({ type: 'application/sdp' }));
app.use('/api', settingsRoutes);

// Serve recorded files
const recordingsDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
app.use('/recordings', express.static(recordingsDir));

// Expose camera list to the frontend (runtime config preferred)
// /api/cameras is now provided by the cameras module when enabled. Leave a compatibility
// fallback that returns the runtime config's videoCameras if no module is mounted.
app.get('/api/cameras', (req, res) => {
  const cfg = loadRuntimeConfig();
  res.json(cfg.videoCameras || {});
});

let priceCache = null;

/*
 * computeSchedule(prices, settings)
 * --------------------------------
 * Determine a boolean schedule for slots across a day based on price data
 * and device settings. This mirrors the implementation used by the
 * Shelly module and is kept here for compatibility/fallback uses by the
 * server.
 */
function computeSchedule(prices, settings) {
  const { minPrice, maxPrice, numCheapest, timeFrame } = settings;
  // canonical unit is 15-minute slots: 96 slots per day
  const slotsPerPeriod = timeFrame === '30min' ? 2 : timeFrame === '1hour' ? 4 : 1;
  const periodsPerDay = 96 / slotsPerPeriod;

  // Calculate average price per period
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

  // Override based on minPrice and maxPrice per period
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

// Shelly API endpoints have been moved into the modules/shelly module.
// The module provides: /api/config/:id, /api/heartbeat/:id, /api/status and related endpoints.

/*
 * GET /api/prices
 * ----------------
 * Return the cached `prices.json` payload (today/tomorrow arrays). Used by
 * the frontend and by devices for scheduling decisions.
 */
app.get('/api/prices', (req, res) => {
  try {
    const prices = JSON.parse(fs.readFileSync('./prices.json', 'utf8'));
    res.json(prices);
  } catch (error) {
    console.error('Error reading prices.json:', error.message);
    res.status(500).json({ error: 'Failed to load prices' });
  }
});

/*
 * GET /api/recordings
 * --------------------
 * Return a list of recorded mp4 files from the recordings directory with
 * metadata (cameraId, url, size, mtime). The client uses this to display
 * recent recordings and allow downloads/deletes.
 */
app.get('/api/recordings', (req, res) => {
  try {
    const files = fs.readdirSync(recordingsDir)
      .filter(f => f.endsWith('.mp4'))
      .map(f => {
        const full = path.join(recordingsDir, f);
        const st = fs.statSync(full);
        // try to parse cameraId and timestamp from filename like "100_motion_166... .mp4"
        const m = f.match(/^(\d+).*?(\d{8,})/);
        let cameraId = null;
        let ts = st.mtimeMs;
        if (m) {
          cameraId = m[1];
          const num = m[2];
          // if looks like epoch millis or seconds, attempt to parse
          if (num.length >= 12) ts = Number(num);
          else if (num.length === 10) ts = Number(num) * 1000;
        }
        return {
          filename: f,
          url: `/recordings/${encodeURIComponent(f)}`,
          cameraId,
          size: st.size,
          mtime: new Date(st.mtime).toISOString(),
          mtimeMs: st.mtimeMs
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    res.json(files);
  } catch (err) {
    console.error('Failed to list recordings:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/*
 * DELETE /api/recordings/:filename
 * --------------------------------
 * Remove a recording file from disk. Validates the filename to avoid
 * directory traversal and returns success/not-found accordingly.
 */
app.delete('/api/recordings/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    if (!filename || filename.includes('..')) return res.status(400).json({ error: 'Invalid filename' });
    const full = path.join(recordingsDir, filename);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(recordingsDir))) return res.status(400).json({ error: 'Invalid filename' });
    if (fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
      return res.json({ success: true });
    } else {
      return res.status(404).json({ error: 'Not found' });
    }
  } catch (err) {
    console.error('Failed to delete recording:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Shelly control/settings/status endpoints have been moved into modules/shelly.
// See modules/shelly for /api/control, /api/save-settings, /api/load-settings,
// /api/shelly-status/:id and /api/sync-rules implementations.

/*
 * POST /api/webrtc/:path
 * ----------------------
 * Proxy browser SDP offers to a local MediaMTX WHEP endpoint. The server
 * relays raw SDP payloads to MediaMTX so the frontend can establish a
 * WebRTC session without directly contacting the relay.
 */
app.post('/api/webrtc/:path', (req, res) => {
  const pathName = req.params.path;
  console.log(`/api/webrtc proxy received for path ${pathName}, content-type=${req.get('Content-Type')}`);
  const mediamtxHost = '127.0.0.1';
  const mediamtxPort = 8889; // must match mediamtx.yml webrtcAddress
  const options = {
    hostname: mediamtxHost,
    port: mediamtxPort,
    path: `/${pathName}/whep`,
    method: 'POST',
    headers: {
      'Content-Type': req.get('Content-Type') || 'application/sdp'
    }
  };

  const proxyReq = http.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      res.status(proxyRes.statusCode).set('Content-Type', proxyRes.headers['content-type'] || 'application/sdp').send(data);
    });
  });
  proxyReq.on('error', (err) => {
    console.error('Error proxying to MediaMTX:', err.message);
    res.status(502).json({ error: 'Failed to contact MediaMTX', detail: err.message });
  });
  // Pipe the raw body (SDP) to MediaMTX
  if (req.body && typeof req.body === 'string') {
    console.log(`/api/webrtc proxy body length: ${req.body.length}`);
    proxyReq.write(req.body);
    proxyReq.end();
  } else {
    // If express.json parsed it into an object, we need raw body; reject
    let raw = req.rawBody || '';
    if (raw) {
      console.log(`/api/webrtc proxy raw body length: ${raw.length}`);
      proxyReq.write(raw);
      proxyReq.end();
    } else {
      // Read stream manually
      req.pipe(proxyReq);
    }
  }
});

// Note: Shelly rule-sync endpoint moved into modules/shelly. Leftover duplicate removed.

// Periodic status checks — use runtime device list
// Periodic Shelly status checks moved to modules/shelly.

// Fetch prices on startup and every 15 minutes
cron.schedule('*/15 * * * *', fetchEnergyPrices);
fetchEnergyPrices().then(() => {
  priceCache = JSON.parse(fs.readFileSync('./prices.json', 'utf8'));
});

// Camera routes moved to modules/cameras. Dynamically load modules now.
const { loadModules } = require('./lib/moduleLoader');
loadModules(app, { loadRuntimeConfig, deps: { ffmpeg, ffmpegAvailable } });

/*
 * GET /health
 * -----------
 * Health check endpoint that returns the overall system health status.
 * Returns 200 if healthy, 503 if unhealthy.
 */
app.get('/health', (req, res) => {
  try {
    const now = new Date();
    let healthy = true;
    const checks = {
      timestamp: now.toISOString(),
      uptime: process.uptime(),
      status: 'healthy'
    };

    // Check if prices.json exists and is recent (within last 2 hours)
    try {
      const stats = fs.statSync('./prices.json');
      const priceAgeHours = (now - stats.mtime) / (1000 * 60 * 60);
      checks.prices = {
        exists: true,
        ageHours: priceAgeHours,
        recent: priceAgeHours < 2
      };
      if (!checks.prices.recent) {
        healthy = false;
        checks.status = 'degraded';
      }
    } catch (error) {
      checks.prices = { exists: false, error: error.message };
      healthy = false;
      checks.status = 'unhealthy';
    }

    // Check device connectivity (at least one device has recent heartbeat)
    const devices = Object.keys(deviceStatus);
    checks.devices = {
      total: devices.length,
      online: 0,
      recentHeartbeats: 0
    };

    devices.forEach(id => {
      const device = deviceStatus[id];
      if (device.online) checks.devices.online++;

      if (device.lastHeartbeat) {
        const heartbeatAge = (now - new Date(device.lastHeartbeat)) / (1000 * 60); // minutes
        if (heartbeatAge < 30) { // within last 30 minutes
          checks.devices.recentHeartbeats++;
        }
      }
    });

    // If no devices have recent heartbeats, consider unhealthy
    if (devices.length > 0 && checks.devices.recentHeartbeats === 0) {
      healthy = false;
      if (checks.status === 'healthy') checks.status = 'degraded';
    }

    const statusCode = healthy ? 200 : (checks.status === 'unhealthy' ? 503 : 200);
    res.status(statusCode).json(checks);

  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/*
 * GET /metrics
 * ------------
 * Prometheus-style metrics endpoint for monitoring system performance.
 */
app.get('/metrics', (req, res) => {
  try {
    const now = new Date();
    let metrics = '# Home Control Center Metrics\n';
    metrics += `# Generated at ${now.toISOString()}\n\n`;

    // System metrics
    metrics += '# HELP hcc_uptime_seconds System uptime in seconds\n';
    metrics += '# TYPE hcc_uptime_seconds gauge\n';
    metrics += `hcc_uptime_seconds ${process.uptime()}\n\n`;

    // Price data metrics
    try {
      const priceData = JSON.parse(fs.readFileSync('./prices.json', 'utf8'));
      const todayPrices = priceData.today || [];
      const tomorrowPrices = priceData.tomorrow || [];

      metrics += '# HELP hcc_prices_today_count Number of price slots for today\n';
      metrics += '# TYPE hcc_prices_today_count gauge\n';
      metrics += `hcc_prices_today_count ${todayPrices.length}\n\n`;

      metrics += '# HELP hcc_prices_tomorrow_count Number of price slots for tomorrow\n';
      metrics += '# TYPE hcc_prices_tomorrow_count gauge\n';
      metrics += `hcc_prices_tomorrow_count ${tomorrowPrices.length}\n\n`;

      // Calculate average prices
      if (todayPrices.length > 0) {
        const avgToday = todayPrices.reduce((sum, slot) => sum + (slot.price || 0), 0) / todayPrices.length;
        metrics += '# HELP hcc_prices_today_avg_cents_per_kwh Average price today in cents/kWh\n';
        metrics += '# TYPE hcc_prices_today_avg_cents_per_kwh gauge\n';
        metrics += `hcc_prices_today_avg_cents_per_kwh ${avgToday.toFixed(4)}\n\n`;
      }

      if (tomorrowPrices.length > 0) {
        const avgTomorrow = tomorrowPrices.reduce((sum, slot) => sum + (slot.price || 0), 0) / tomorrowPrices.length;
        metrics += '# HELP hcc_prices_tomorrow_avg_cents_per_kwh Average price tomorrow in cents/kWh\n';
        metrics += '# TYPE hcc_prices_tomorrow_avg_cents_per_kwh gauge\n';
        metrics += `hcc_prices_tomorrow_avg_cents_per_kwh ${avgTomorrow.toFixed(4)}\n\n`;
      }

    } catch (error) {
      metrics += '# Price data unavailable\n\n';
    }

    // Device metrics
    const devices = Object.keys(deviceStatus);
    metrics += '# HELP hcc_devices_total Total number of configured devices\n';
    metrics += '# TYPE hcc_devices_total gauge\n';
    metrics += `hcc_devices_total ${devices.length}\n\n`;

    let onlineDevices = 0;
    let devicesWithRecentHeartbeat = 0;

    devices.forEach(id => {
      const device = deviceStatus[id];
      if (device.online) onlineDevices++;

      if (device.lastHeartbeat) {
        const heartbeatAge = (now - new Date(device.lastHeartbeat)) / (1000 * 60); // minutes
        if (heartbeatAge < 30) devicesWithRecentHeartbeat++;

        metrics += `# HELP hcc_device_heartbeat_age_minutes Device ${id} heartbeat age in minutes\n`;
        metrics += '# TYPE hcc_device_heartbeat_age_minutes gauge\n';
        metrics += `hcc_device_heartbeat_age_minutes{device="${id}"} ${heartbeatAge.toFixed(2)}\n`;
      }

      if (device.lastPrice !== null) {
        metrics += `# HELP hcc_device_last_price_cents_per_kwh Device ${id} last known price\n`;
        metrics += '# TYPE hcc_device_last_price_cents_per_kwh gauge\n';
        metrics += `hcc_device_last_price_cents_per_kwh{device="${id}"} ${device.lastPrice}\n`;
      }
    });

    metrics += '# HELP hcc_devices_online Number of online devices\n';
    metrics += '# TYPE hcc_devices_online gauge\n';
    metrics += `hcc_devices_online ${onlineDevices}\n\n`;

    metrics += '# HELP hcc_devices_recent_heartbeats Number of devices with heartbeat in last 30 minutes\n';
    metrics += '# TYPE hcc_devices_recent_heartbeats gauge\n';
    metrics += `hcc_devices_recent_heartbeats ${devicesWithRecentHeartbeat}\n\n`;

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(metrics);

  } catch (error) {
    logger.error('Metrics generation failed', { error: error.message });
    res.status(500).send(`# Error generating metrics: ${error.message}\n`);
  }
});

app.listen(SERVER_PORT, SERVER_IP, () => {
  console.log(`Server running on http://${SERVER_IP}:${SERVER_PORT}`);
});