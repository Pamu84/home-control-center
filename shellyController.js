const axios = require('axios');
const { getDevices, getServerConfig } = require('./config/manager');
const { SERVER_IP, SERVER_PORT } = getServerConfig();
const { sendTelegramMessage } = require('./notificationManager');
const { getDeviceLastNotified, setDeviceLastNotified, clearDeviceLastNotified } = require('./notificationState');
const fs = require('fs');
const path = require('path');

/*
 * resolveDeviceIp(id)
 * -------------------
 * Resolve the network IP address for a given device id. Handles both
 * object-based declarations ({ ip: 'x.x.x.x' }) and string shorthand.
 */
function resolveDeviceIp(id) {
  const devices = getDevices();
  const entry = devices[id];
  if (!entry) return null;
  if (typeof entry === 'object') return entry.ip;
  return String(entry);
}

/*
 * deviceStatus
 * ------------
 * In-memory map of per-device runtime status used by the server and the
 * UI. Keys are device IDs. Values include online, lastHeartbeat, switchOn,
 * lastPrice, lastSync and error information. Persisted notification state is
 * stored separately via notificationState helpers.
 */
const deviceStatus = {};

/*
 * ensureDeviceState(id)
 * ---------------------
 * Initialize `deviceStatus[id]` with sane defaults if it does not exist.
 * This is a helper invoked before updating or reading device state.
 */
function ensureDeviceState(id) {
  if (!deviceStatus[id]) {
    deviceStatus[id] = {
      online: false,
      lastHeartbeat: null,
      switchOn: false,
      lastPrice: null,
      lastSync: null,
      error: null,
      lastNotified: getDeviceLastNotified(id) // load persisted notification timestamp
    };
  }
}

/*
 * turnOnShelly(id)
 * -----------------
 * Attempt to turn the physical relay on for the given Shelly device.
 * Uses a tiered fallback strategy:
 *  1) Preferred: POST to device's `/control` script endpoint
 *  2) Fallback: Shelly RPC `Switch.Set`
 *  3) Legacy: HTTP relay endpoint
 * Updates `deviceStatus` and throws on total failure.
 */
async function turnOnShelly(id) {
  const ip = resolveDeviceIp(id);
  if (!ip) throw new Error(`Unknown Shelly device: ${id}`);
  ensureDeviceState(id);
  try {
    console.log(`Attempting to turn ON Shelly ${id} at http://${ip}/control`);
    // Preferred: Shelly Script control endpoint
    try {
      const response = await axios.post(`http://${ip}/control`, { action: "turnOn" }, { timeout: 5000 });
      console.log(`Shelly ${id} turned ON (script):`, response.data);
      deviceStatus[id].switchOn = true;
      deviceStatus[id].error = null;
      return response.data;
    } catch (errScript) {
      console.warn(`Shelly ${id} script /control failed: ${errScript.message}`);
      // Fallback to standard Shelly RPC
    }

    // Fallback 1: Shelly RPC API (Switch.Set)
    try {
      console.log(`Attempting Shelly RPC Switch.Set for ${id} at http://${ip}/rpc/Switch.Set`);
      const rpcResp = await axios.post(`http://${ip}/rpc/Switch.Set`, { id: 0, on: true }, { timeout: 5000 });
      console.log(`Shelly ${id} turned ON (rpc):`, rpcResp.data);
      deviceStatus[id].switchOn = true;
      deviceStatus[id].error = null;
      return rpcResp.data;
    } catch (errRpc) {
      console.warn(`Shelly ${id} RPC Switch.Set failed: ${errRpc.message}`);
      // Fallback 2: legacy relay HTTP endpoint
    }

    // Fallback 2: Legacy GET endpoint for older firmwares
    try {
      console.log(`Attempting legacy relay endpoint for ${id} at http://${ip}/relay/0?turn=on`);
      const legacy = await axios.get(`http://${ip}/relay/0?turn=on`, { timeout: 5000 });
      console.log(`Shelly ${id} turned ON (legacy):`, legacy.data);
      deviceStatus[id].switchOn = true;
      deviceStatus[id].error = null;
      return legacy.data;
    } catch (errLegacy) {
      console.error(`All control attempts failed for Shelly ${id}:`, errLegacy.message);
      deviceStatus[id].error = errLegacy.message;
      throw new Error(`Failed to turn ON Shelly ${id}: ${errLegacy.message}`);
    }
  } catch (error) {
    // This should not be reached due to returns above, but keep for safety
    console.error(`Failed to turn ON Shelly ${id}:`, error.message, error.code);
    deviceStatus[id].error = error.message;
    throw new Error(`Failed to turn ON Shelly ${id}: ${error.message}`);
  }
}

/*
 * turnOffShelly(id)
 * ------------------
 * Attempt to turn the physical relay off for the given Shelly device.
 * Uses the same multi-tier fallback strategy as turnOnShelly.
 */
async function turnOffShelly(id) {
  const ip = resolveDeviceIp(id);
  if (!ip) throw new Error(`Unknown Shelly device: ${id}`);
  ensureDeviceState(id);
  try {
    console.log(`Attempting to turn OFF Shelly ${id} at http://${ip}/control`);
    // Preferred: Shelly Script control endpoint
    try {
      const response = await axios.post(`http://${ip}/control`, { action: "turnOff" }, { timeout: 5000 });
      console.log(`Shelly ${id} turned OFF (script):`, response.data);
      deviceStatus[id].switchOn = false;
      deviceStatus[id].error = null;
      return response.data;
    } catch (errScript) {
      console.warn(`Shelly ${id} script /control failed: ${errScript.message}`);
    }

    // Fallback 1: Shelly RPC API (Switch.Set)
    try {
      console.log(`Attempting Shelly RPC Switch.Set OFF for ${id} at http://${ip}/rpc/Switch.Set`);
      const rpcResp = await axios.post(`http://${ip}/rpc/Switch.Set`, { id: 0, on: false }, { timeout: 5000 });
      console.log(`Shelly ${id} turned OFF (rpc):`, rpcResp.data);
      deviceStatus[id].switchOn = false;
      deviceStatus[id].error = null;
      return rpcResp.data;
    } catch (errRpc) {
      console.warn(`Shelly ${id} RPC Switch.Set failed: ${errRpc.message}`);
    }

    // Fallback 2: Legacy GET endpoint for older firmwares
    try {
      console.log(`Attempting legacy relay endpoint for ${id} at http://${ip}/relay/0?turn=off`);
      const legacy = await axios.get(`http://${ip}/relay/0?turn=off`, { timeout: 5000 });
      console.log(`Shelly ${id} turned OFF (legacy):`, legacy.data);
      deviceStatus[id].switchOn = false;
      deviceStatus[id].error = null;
      return legacy.data;
    } catch (errLegacy) {
      console.error(`All control attempts failed for Shelly ${id}:`, errLegacy.message);
      deviceStatus[id].error = errLegacy.message;
      throw new Error(`Failed to turn OFF Shelly ${id}: ${errLegacy.message}`);
    }
  } catch (error) {
    console.error(`Failed to turn OFF Shelly ${id}:`, error.message, error.code);
    deviceStatus[id].error = error.message;
    throw new Error(`Failed to turn OFF Shelly ${id}: ${error.message}`);
  }
}

/*
 * clearOverride(id)
 * -----------------
 * Attempt to clear a manual override on the device. Tries the device's
 * `/control` script endpoint first and falls back to a Shelly RPC refresh
 * if the script is not present. This is used to return the device to
 * automated control after a manual override has been cleared.
 */
async function clearOverride(id) {
  const ip = resolveDeviceIp(id);
  if (!ip) throw new Error(`Unknown Shelly device: ${id}`);
  ensureDeviceState(id);
  try {
    console.log(`Attempting to clear override for Shelly ${id} at http://${ip}/control`);
    try {
      const response = await axios.post(`http://${ip}/control`, { action: "clearOverride" }, { timeout: 5000 });
      console.log(`Shelly ${id} override cleared (script):`, response.data);
      deviceStatus[id].error = null;
      return response.data;
    } catch (err) {
      console.warn(`Shelly ${id} clearOverride via /control failed: ${err.message}`);
      // If script not present, attempt to trigger a refreshConfig via RPC or skip
      try {
        const rpcResp = await axios.post(`http://${ip}/rpc/Shelly.Refresh`, {}, { timeout: 5000 });
        console.log(`Shelly ${id} refresh triggered (rpc):`, rpcResp.data);
        deviceStatus[id].error = null;
        return rpcResp.data;
      } catch (err2) {
        console.warn(`Shelly ${id} refresh RPC failed: ${err2.message}`);
        throw err2;
      }
    }
  } catch (error) {
    console.error(`Failed to clear override on Shelly ${id}:`, error.message, error.code);
    deviceStatus[id].error = error.message;
    throw new Error(`Failed to clear override on Shelly ${id}: ${error.message}`);
  }
}

/*
 * getShellyStatus(id)
 * -------------------
 * Perform an RPC-style status fetch from the device's `/rpc/Shelly.GetStatus`
 * endpoint. On success, updates `deviceStatus[id]` with structured fields.
 * On failure, populates error fields and may trigger a notification if the
 * device appears to have been offline for too long.
 */
async function getShellyStatus(id) {
  const ip = resolveDeviceIp(id);
  if (!ip) {
    console.warn(`Unknown Shelly device: ${id}`);
    return {
      online: false,
      working: false,
      switchOn: false,
      lastChecked: new Date().toISOString(),
      lastHeartbeat: null,
      lastPrice: null,
      lastSync: null,
      error: `Unknown Shelly device: ${id}`
    };
  }
  ensureDeviceState(id);
  try {
    console.log(`Fetching status for Shelly ${id} at http://${ip}/rpc/Shelly.GetStatus`);
    const response = await axios.get(`http://${ip}/rpc/Shelly.GetStatus`, { timeout: 5000 });
    const data = response.data;
    const status = {
      online: data.wifi && data.wifi.status === 'got ip',
      working: data.sys && data.sys.uptime > 0,
      switchOn: data['switch:0'] ? data['switch:0'].output : false,
      lastChecked: new Date().toISOString(),
      lastHeartbeat: deviceStatus[id].lastHeartbeat,
      lastPrice: deviceStatus[id].lastPrice,
      lastSync: deviceStatus[id].lastSync,
      error: null
    };
    deviceStatus[id] = { ...deviceStatus[id], ...status };
    return status;
  } catch (error) {
    console.error(`Failed to get status for Shelly ${id}:`, error.message, error.code);
    // Preserve previous notification timestamp to avoid duplicates
  const prevLastNotified = deviceStatus[id] ? deviceStatus[id].lastNotified : null;
    const status = {
      online: false,
      working: false,
      switchOn: false,
      lastChecked: new Date().toISOString(),
      lastHeartbeat: deviceStatus[id].lastHeartbeat,
      lastPrice: deviceStatus[id].lastPrice,
      lastSync: deviceStatus[id].lastSync,
      error: error.message
    };
  deviceStatus[id] = { ...deviceStatus[id], ...status };

    // If RPC failed and there is no recent heartbeat (or none at all), send an immediate alert
    try {
      const lastHeartbeat = deviceStatus[id].lastHeartbeat ? new Date(deviceStatus[id].lastHeartbeat).getTime() : null;
      const threshold = 10 * 60 * 1000; // 10 minutes
      const now = Date.now();
      const lastNotified = prevLastNotified ? new Date(prevLastNotified).getTime() : 0;

      if (!lastHeartbeat || (now - lastHeartbeat) > threshold) {
        // Only notify if we haven't already notified for this heartbeat
          if (!lastNotified || lastNotified < (lastHeartbeat || 0)) {
            // Include error.code when available to help diagnostics (e.g. EHOSTUNREACH)
            const errCode = error && error.code ? ` (${error.code})` : '';
            const msg = `⚠️ Shelly *${id}* unreachable (RPC).\nError: ${error.message}${errCode}`;
            try {
              console.log(`Sending Shelly offline notification for ${id}: ${msg}`);
              sendTelegramMessage(msg);
              const nowIso = new Date().toISOString();
              deviceStatus[id].lastNotified = nowIso;
              try {
                // Persist the device-level notification timestamp to avoid duplicates across restarts
                setDeviceLastNotified(id, nowIso);
              } catch (e2) {
                console.error(`Failed to persist device notification timestamp for Shelly ${id}:`, e2.message);
              }
            } catch (e) {
              console.error(`Failed to send immediate RPC-failure notification for Shelly ${id}:`, e.message);
            }
        }
      }
    } catch (e) {
      console.error(`Failed to send immediate RPC-failure notification for Shelly ${id}:`, e.message);
    }

    return status;
  }
}

/*
 * handleHeartbeat(id, data)
 * -------------------------
 * Process heartbeat payloads sent by device-side scripts. Normalizes
 * timestamps (lastSync) provided by the device and updates `deviceStatus`.
 * Also clears persisted offline notifications for the device when a valid
 * heartbeat is received.
 */
function handleHeartbeat(id, data) {
  const devices = getDevices();
  if (!devices[id]) {
    console.warn(`Heartbeat from unknown Shelly device: ${id}`);
    return { status: "error", message: `Unknown device: ${id}` };
  }
  ensureDeviceState(id);
  try {
    // Normalize lastSync into an ISO timestamp.
    let lastSyncIso = deviceStatus[id] ? deviceStatus[id].lastSync : null;
    try {
      if (typeof data.lastSync !== 'undefined' && data.lastSync !== null) {
        const lastSyncVal = Number(data.lastSync);
        if (typeof data.uptime !== 'undefined' && data.uptime !== null) {
          const uptimeNow = Number(data.uptime);
          if (!isNaN(uptimeNow) && !isNaN(lastSyncVal) && uptimeNow >= lastSyncVal) {
            const deltaMs = (uptimeNow - lastSyncVal) * 1000;
            lastSyncIso = new Date(Date.now() - deltaMs).toISOString();
          } else if (lastSyncVal > 1e12) {
            lastSyncIso = new Date(lastSyncVal).toISOString();
          } else if (lastSyncVal > 1e9) {
            lastSyncIso = new Date(lastSyncVal * 1000).toISOString();
          }
        } else {
          if (lastSyncVal > 1e12) lastSyncIso = new Date(lastSyncVal).toISOString();
          else if (lastSyncVal > 1e9) lastSyncIso = new Date(lastSyncVal * 1000).toISOString();
        }
      }
    } catch (e) {
      console.warn(`shellyController: failed to normalize lastSync for ${id}: ${e.message}`);
    }

    deviceStatus[id] = {
      ...deviceStatus[id],
      online: true,
      lastHeartbeat: new Date().toISOString(),
      switchOn: data.switchOn || false,
      lastPrice: data.lastPrice || null,
      lastSync: lastSyncIso || (deviceStatus[id] && deviceStatus[id].lastSync) || null,
      lastConfigUpdate: data.lastConfigUpdate || null,
      error: null
    };
    // Received heartbeat: clear any persisted offline notification for this device
    try {
      clearDeviceLastNotified(id);
      deviceStatus[id].lastNotified = null;
    } catch (e) {
      console.error(`Failed to clear persisted notification state for Shelly ${id}:`, e.message);
    }
    console.log(`Heartbeat received from Shelly ${id}:`, deviceStatus[id]);
    return { status: "ok" };
  } catch (error) {
    console.error(`Failed to process heartbeat for Shelly ${id}:`, error.message);
    return { status: "error", message: error.message };
  }
}

/*
 * checkOfflineDevices()
 * ----------------------
 * Periodically scan devices and send alerts for devices that have not
 * reported a heartbeat within the configured threshold. Uses persisted
 * notification timestamps to avoid duplicate alerts across restarts.
 */
function checkOfflineDevices() {
  const now = Date.now();
  const devices = getDevices();
  Object.keys(devices).forEach(id => {
    const lastHeartbeat = deviceStatus[id] && deviceStatus[id].lastHeartbeat ? new Date(deviceStatus[id].lastHeartbeat).getTime() : null;
    const thresholdTime = 10 * 60 * 1000; // 10 minutes
    const age = lastHeartbeat ? (now - lastHeartbeat) : null;
    console.log(`Offline check for Shelly ${id}: online=${deviceStatus[id].online}, lastHeartbeat=${deviceStatus[id].lastHeartbeat}, age=${age}, lastNotified=${deviceStatus[id].lastNotified}`);

    // If the device is currently reachable according to RPC polling, skip heartbeat-based notification.
    // Many devices may not send heartbeats; rely on RPC `online` state when available to avoid false alerts.
    if (deviceStatus[id].online) {
      console.log(`Skipping offline notification for Shelly ${id} because RPC reports it online`);
      return; // next device
    }

    if (lastHeartbeat && age > thresholdTime) {
      // Use persisted lastNotified to avoid duplicates across restarts
  const persistedNotified = getDeviceLastNotified(id);
  const lastNotified = persistedNotified ? new Date(persistedNotified).getTime() : null;
      if (!lastNotified || lastNotified < lastHeartbeat) {
        // Send alert
        try {
          sendTelegramMessage(`⚠️ Shelly *${id}* is offline.\nLast heartbeat: ${deviceStatus[id].lastHeartbeat}`);
          const nowIso = new Date().toISOString();
          deviceStatus[id].lastNotified = nowIso;
          setDeviceLastNotified(id, nowIso);
        } catch (e) {
          console.error(`Failed to send offline notification for Shelly ${id}:`, e.message);
        }
      }
      deviceStatus[id].online = false;
      deviceStatus[id].error = "No heartbeat received for over 10 minutes";
      console.warn(`Shelly ${id} marked offline: no heartbeat since ${deviceStatus[id].lastHeartbeat}`);
    }
  });
}

// Run offline check every 5 minutes
setInterval(checkOfflineDevices, 5 * 60 * 1000);

module.exports = {
  getDevices,
  turnOnShelly,
  turnOffShelly,
  clearOverride,
  getShellyStatus,
  handleHeartbeat,
  deviceStatus
};