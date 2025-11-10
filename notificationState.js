const fs = require('fs');
const path = require('path');

/*
 * STATE_PATH
 * ----------
 * File path where notification timestamps are persisted to avoid duplicate
 * alerts across server restarts. Structure is an object with `serverNotified`
 * and `devices` mapping deviceId -> ISO timestamp.
 */
const STATE_PATH = path.join(__dirname, 'notification_state.json');

/*
 * loadState()
 * -----------
 * Read and parse the persisted notification state from disk. Returns a
 * fallback object when the file is missing or cannot be parsed.
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, 'utf8');
      return JSON.parse(raw || '{}');
    }
  } catch (e) {
    console.error('Failed to load notification state:', e.message);
  }
  return { serverNotified: null, devices: {} };
}

/*
 * saveState(state)
 * ----------------
 * Persist the provided state object to disk. Errors are logged but not
 * propagated to callers since notification state is best-effort.
 */
function saveState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Failed to save notification state:', e.message);
  }
}

/*
 * isServerNotified()
 * -------------------
 * Convenience accessor that returns whether the server-level notification
 * flag has been set (useful to avoid spamming admins with the same alert).
 */
function isServerNotified() {
  const s = loadState();
  return !!s.serverNotified;
}

/*
 * setServerNotified(ts)
 * ---------------------
 * Mark that the server-level notification was sent at `ts` (ISO string).
 * If `ts` is omitted the current time will be used.
 */
function setServerNotified(ts) {
  const s = loadState();
  s.serverNotified = ts || new Date().toISOString();
  saveState(s);
}

/*
 * clearServerNotified()
 * ----------------------
 * Clear the persisted server notification flag.
 */
function clearServerNotified() {
  const s = loadState();
  s.serverNotified = null;
  saveState(s);
}

/*
 * getDeviceLastNotified(id)
 * -------------------------
 * Return the persisted ISO timestamp for when a device-level notification
 * was last sent, or null if none exists.
 */
function getDeviceLastNotified(id) {
  const s = loadState();
  return s.devices && s.devices[id] ? s.devices[id] : null;
}

/*
 * setDeviceLastNotified(id, ts)
 * -----------------------------
 * Persist the timestamp when a notification for device `id` was last sent.
 */
function setDeviceLastNotified(id, ts) {
  const s = loadState();
  s.devices = s.devices || {};
  s.devices[id] = ts || new Date().toISOString();
  saveState(s);
}

/*
 * clearDeviceLastNotified(id)
 * ---------------------------
 * Remove the persisted last-notified timestamp for a device, allowing new
 * alerts to be sent again.
 */
function clearDeviceLastNotified(id) {
  const s = loadState();
  if (s.devices && s.devices[id]) {
    delete s.devices[id];
    saveState(s);
  }
}

module.exports = {
  isServerNotified,
  setServerNotified,
  clearServerNotified,
  getDeviceLastNotified,
  setDeviceLastNotified,
  clearDeviceLastNotified
};
