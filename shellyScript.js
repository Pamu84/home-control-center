/*
 * Shelly script configuration object
 * -------------------------------
 * CONFIG holds local device settings and runtime state used by the
 * Shelly Script running on the device. Fields are populated from server
 * `/api/config/:id` responses and include pricing/schedule arrays.
 */
var CONFIG = {
  deviceId: "1", //deviceId: "1", // Set to "1", "2", or "3" per device
  serverUrl: "http://192.168.1.10:3000",
  minPrice: 0.05,
  maxPrice: 0.20,
  numCheapest: 4,
  timeFrame: "15min",
  manualOverride: false,
  manualState: null,
  reversedControl: false,
  // Devices run a minimal JS engine that may not support Array.fill.
  // Use a small helper to create the fallbackHours array.
  fallbackHours: (function(){ var a=[]; for (var i=0;i<24;i++) a.push(false); return a; })(),
  prices: [], // Array of prices for today and tomorrow
  schedule: [], // Array of 96 boolean values (15-min slots) for ON/OFF
  lastSync: 0,
  lastChecked: 0,
  lastPrice: null,
  serverStatus: false,
  lastConfigUpdate: null // Track last config timestamp
};

/*
 * SCRIPT_VERSION
 * --------------
 * Identifier that can be displayed in device heartbeats/logs so operators
 * know which script revision is running on each Shelly device.
 */
var SCRIPT_VERSION = '2025-10-30-1';

/*
 * log(msg)
 * -------
 * Simple helper that prefixes messages with the device id for easier
 * debugging in device logs.
 */
function log(msg) {
  print("Shelly " + CONFIG.deviceId + ": " + msg);
}

/*
 * getTimeSlot()
 * -------------
 * Compute the current 15-minute slot index (0-95) based on wall-clock
 * UTC time. This avoids using device uptime which can produce incorrect
 * slot numbers after device reboots. Falls back to uptime-based calc if
 * Date() is unavailable.
 */
function getTimeSlot() {
  // Use actual wall-clock time (UTC) to compute the 15-minute slot index.
  // Using device uptime caused incorrect slot calculation and toggling when device reboots.
  try {
    var now = new Date();
    var utcHours = now.getUTCHours();
    var utcMinutes = now.getUTCMinutes();
    return utcHours * 4 + Math.floor(utcMinutes / 15);
  } catch (e) {
    // Fallback to uptime-based calculation if Date() fails for some reason
    var ts = Shelly.getComponentStatus("sys").uptime;
    var hours = Math.floor((ts % 86400) / 3600);
    var minutes = Math.floor((ts % 3600) / 60);
    return Math.floor((hours * 60 + minutes) / 15);
  }
}

/*
 * getSlotsPerPeriod()
 * --------------------
 * Return number of 15-minute slots per configured period based on
 * CONFIG.timeFrame. Defaults to 1 (15min).
 */
function getSlotsPerPeriod() {
  try {
    if (CONFIG.timeFrame === '30min') return 2;
    if (CONFIG.timeFrame === '1hour') return 4;
  } catch (e) {}
  return 1;
}

/*
 * resolveServerSlot(s)
 * ---------------------
 * Server may send `serverSlot` either as a 15-min slot index (0-95)
 * or as a period index when using coarse time frames (e.g. 0-23 for 1hour).
 * This function maps the provided serverSlot to a 15-min slot index that
 * can be used to read `CONFIG.prices` and `CONFIG.schedule` safely.
 */
function resolveServerSlot(s) {
  if (typeof s !== 'number' || isNaN(s)) return null;
  var spp = getSlotsPerPeriod();
  // total known periods based on available prices
  var totalPeriods = Math.ceil((Array.isArray(CONFIG.prices) ? CONFIG.prices.length : 0) / spp);
  // If serverSlot looks like a period index (0..totalPeriods-1) prefer mapping
  if (s >= 0 && s < totalPeriods) {
    return s * spp; // map to first 15-min slot of that period
  }
  // Otherwise assume it's already a 15-min slot index
  if (s >= 0 && s < (Array.isArray(CONFIG.prices) ? CONFIG.prices.length : 0)) return s;
  return null;
}

/*
 * validateConfig()
 * -----------------
 * Ensure that CONFIG contains sane `prices` and `schedule` arrays. Returns
 * true when the data looks usable (sufficient non-zero price points and
 * expected array lengths) and false otherwise.
 */
function validateConfig() {
  if (!Array.isArray(CONFIG.prices) || CONFIG.prices.length < 96) {
    log("Invalid prices: length=" + (CONFIG.prices.length || 0));
    return false;
  }
  if (!Array.isArray(CONFIG.schedule) || CONFIG.schedule.length !== 96) {
    log("Invalid schedule: length=" + (CONFIG.schedule.length || 0));
    return false;
  }
  var nonZeroPrices = 0;
  for (var i = 0; i < CONFIG.prices.length; i++) {
    if (typeof CONFIG.prices[i] !== "number" || isNaN(CONFIG.prices[i])) {
      log("Invalid price at index " + i);
      return false;
    }
    if (CONFIG.prices[i] > 0) nonZeroPrices++;
  }
  for (var i = 0; i < CONFIG.schedule.length; i++) {
    if (typeof CONFIG.schedule[i] !== "boolean") {
      log("Invalid schedule at index " + i);
      return false;
    }
  }
  if (nonZeroPrices < 48) {
    log("Too few non-zero prices: " + nonZeroPrices);
    return false;
  }
  return true;
}

/*
 * applyRules()
 * ------------
 * Main decision routine executed periodically. Determines the current
 * logical desired state (based on schedule and prices) and sets the
 * physical relay accordingly, honoring `reversedControl` and `manualOverride`.
 */
function applyRules() {
  try {
  // Prefer server-provided slot (if present) to protect against incorrect RTC on device.
  var slot = getTimeSlot();
  try {
    if (typeof CONFIG.serverSlot === 'number' && CONFIG.serverSlot !== null) {
      var resolved = resolveServerSlot(CONFIG.serverSlot);
      if (typeof resolved === 'number' && resolved !== null) slot = resolved;
    }
  } catch (e) { /* ignore and use local slot */ }
    if (CONFIG.manualOverride) {
        // If manualState is explicitly provided, honor it. If not provided, preserve current switch state
        if (CONFIG.manualState === 'on') {
          log("Manual override: forced ON");
          var phys = CONFIG.reversedControl ? false : true;
          Shelly.call("Switch.Set", { id: 0, on: phys });
          return;
        } else if (CONFIG.manualState === 'off') {
          log("Manual override: forced OFF");
          var phys = CONFIG.reversedControl ? true : false;
          Shelly.call("Switch.Set", { id: 0, on: phys });
          return;
        } else {
          // Manual override active but no explicit manualState: do not modify the switch (preserve current state)
          log("Manual override active (no explicit state) - preserving current switch state");
          return;
        }
    }
  if (!validateConfig()) {
      // If the full config isn't valid, prefer fallbackHours (24-entry array)
      // when available. This allows the device to continue operating even
      // when the server or price feed is down.
      if (Array.isArray(CONFIG.fallbackHours) && CONFIG.fallbackHours.length === 24) {
  var hour;
  try { hour = new Date().getUTCHours(); } catch (e) { hour = Math.floor((Shelly.getComponentStatus("sys").uptime % 86400) / 3600); }
  var fallbackOn = !!CONFIG.fallbackHours[hour];
        log("No valid full config, using fallbackHours for hour " + hour + ": " + (fallbackOn ? "ON" : "OFF"));
        var phys = CONFIG.reversedControl ? !fallbackOn : fallbackOn;
        Shelly.call("Switch.Set", { id: 0, on: phys });
        return;
      } else {
        log("No valid config and no fallbackHours, switch OFF (respecting reversedControl)");
        var phys = CONFIG.reversedControl ? true : false; // if reversed, physical ON == logical OFF
        Shelly.call("Switch.Set", { id: 0, on: phys });
        return;
      }
    }
  var price = (Array.isArray(CONFIG.prices) && CONFIG.prices.length > slot) ? CONFIG.prices[slot] : null;
  var shouldBeOn = (Array.isArray(CONFIG.schedule) && CONFIG.schedule.length > slot) ? CONFIG.schedule[slot] : false;
    CONFIG.lastPrice = price;
    log("Slot " + slot + ": price=" + price + ", schedule=" + (shouldBeOn ? "ON" : "OFF"));
    // Also log the wall-clock time for debugging
    try {
      var now = new Date();
      // Log both UTC and a local (configurable) timezone for clarity in device logs.
      var utc = now.toISOString();
      var tzOffset = (typeof CONFIG.timezoneOffsetHours === 'number') ? CONFIG.timezoneOffsetHours : 2; // default to Finland
      var local = new Date(now.getTime() + tzOffset * 3600 * 1000).toISOString().replace('Z', '') + (tzOffset >= 0 ? '+' + tzOffset : '' + tzOffset);
      log("Wall time UTC: " + utc + "  Local(~offset): " + local);
    } catch (e) {}
  var phys = CONFIG.reversedControl ? !shouldBeOn : shouldBeOn;
    Shelly.call("Switch.Set", { id: 0, on: phys });
  } catch (e) {
    log("applyRules error: " + e);
    var phys = CONFIG.reversedControl ? true : false;
    Shelly.call("Switch.Set", { id: 0, on: phys });
  }
}

/*
 * syncConfig()
 * ------------
 * Pull the latest configuration from the server's `/api/config/:id` and
 * merge it into local CONFIG. Supports a simple retry mechanism and will
 * immediately apply `reversedControl` and update `lastPrice` using
 * serverSlot to make device heartbeats reflect server data.
 */
function syncConfig() {
  var maxRetries = 3;
  var baseDelay = 10000; // 10 seconds

  function attemptSync(retryCount) {
    var attemptStart = Shelly.getComponentStatus("sys").uptime;

    Shelly.call("HTTP.GET", {
      url: CONFIG.serverUrl + "/api/config/" + CONFIG.deviceId,
      timeout: 15000 // 15 second timeout
    }, function(result, errorCode, errorMessage) {
      var responseTime = Shelly.getComponentStatus("sys").uptime - attemptStart;
      CONFIG.lastChecked = Shelly.getComponentStatus("sys").uptime;

      var statusCode = result && result.code !== undefined ? result.code : errorCode;

      // Log the attempt result
      log("Server sync attempt " + (retryCount + 1) + "/" + (maxRetries + 1) +
          " - code: " + statusCode + ", time: " + responseTime + "s" +
          ", error: " + (errorMessage || "N/A"));

      if (result && statusCode === 200 && result.body) {
        try {
          var newConfig = JSON.parse(result.body);

          // Validate essential config fields
          if (!newConfig.deviceId || !Array.isArray(newConfig.prices) || !Array.isArray(newConfig.schedule)) {
            throw new Error("Invalid config structure: missing required fields");
          }

          if (newConfig.prices.length < 96 || newConfig.schedule.length !== 96) {
            throw new Error("Invalid config data: prices.length=" + newConfig.prices.length + ", schedule.length=" + newConfig.schedule.length);
          }
              // If server provides a serverSlot/serverTime, store them so we can prefer
              // server-provided slot calculation (useful when device RTC is wrong).
              if (typeof newConfig.serverSlot !== 'undefined') {
                CONFIG.serverSlot = Number(newConfig.serverSlot);
              } else {
                CONFIG.serverSlot = null;
              }
              if (typeof newConfig.serverTime !== 'undefined') CONFIG.serverTime = newConfig.serverTime;
          // Always update reversedControl immediately so scheduled behavior
          // uses the server-provided reversal flag even if the server's
          // lastUpdated timestamp hasn't changed.
          try {
            if (typeof newConfig.reversedControl !== 'undefined') {
              CONFIG.reversedControl = !!newConfig.reversedControl;
            }
          } catch (e) {
            log('Failed to apply reversedControl from server: ' + e);
          }
          // Even if the server config timestamp is not newer, update lastPrice from
          // the currently known prices when serverSlot is present so heartbeats
          // reflect the server's current slot price immediately.
          try {
            if (typeof CONFIG.serverSlot === 'number' && CONFIG.serverSlot !== null) {
              var resolvedSlot = resolveServerSlot(CONFIG.serverSlot);
              if (typeof resolvedSlot === 'number' && Array.isArray(CONFIG.prices) && CONFIG.prices.length > resolvedSlot) {
                CONFIG.lastPrice = CONFIG.prices[resolvedSlot];
              }
            }
          } catch (e) {
            log('Failed to set lastPrice from serverSlot: ' + e);
          }
          if (!CONFIG.lastConfigUpdate || new Date(newConfig.lastUpdated) > new Date(CONFIG.lastConfigUpdate)) {
            CONFIG.deviceId = newConfig.deviceId || CONFIG.deviceId;
            CONFIG.minPrice = newConfig.minPrice || CONFIG.minPrice;
            CONFIG.maxPrice = newConfig.maxPrice || CONFIG.maxPrice;
            CONFIG.numCheapest = newConfig.numCheapest || CONFIG.numCheapest;
            CONFIG.timeFrame = newConfig.timeFrame || CONFIG.timeFrame;
            CONFIG.manualOverride = newConfig.manualOverride || false;
            CONFIG.reversedControl = newConfig.reversedControl || false;
            // Merge fallback hours if provided by server (array of 24 booleans)
            CONFIG.fallbackHours = Array.isArray(newConfig.fallbackHours) && newConfig.fallbackHours.length === 24 ? newConfig.fallbackHours.slice(0,24) : (CONFIG.fallbackHours || (function(){ var a=[]; for (var i=0;i<24;i++) a.push(false); return a; })());
            // Respect explicit manualState sent by server: 'on' | 'off' | null
            CONFIG.manualState = (typeof newConfig.manualState !== 'undefined' && newConfig.manualState !== null) ? newConfig.manualState : null;
            CONFIG.prices = newConfig.prices || [];
            CONFIG.schedule = newConfig.schedule || [];
            // If the server provides a serverSlot, update lastPrice to the price at that slot
            if (typeof CONFIG.serverSlot === 'number' && CONFIG.serverSlot !== null) {
              var resolvedSlot2 = resolveServerSlot(CONFIG.serverSlot);
              if (typeof resolvedSlot2 === 'number' && Array.isArray(CONFIG.prices) && CONFIG.prices.length > resolvedSlot2) {
                CONFIG.lastPrice = CONFIG.prices[resolvedSlot2];
              }
            }
            CONFIG.lastSync = Shelly.getComponentStatus("sys").uptime;
            CONFIG.lastConfigUpdate = newConfig.lastUpdated || new Date().toISOString();
            CONFIG.serverStatus = true;
            log("Config synced: prices=" + CONFIG.prices.length + ", schedule=" + CONFIG.schedule.length);
            if (validateConfig()) {
              applyRules();
            } else {
              log("Invalid config, switch OFF");
              Shelly.call("Switch.Set", { id: 0, on: false });
            }
          } else {
            log("Config not updated: server config is not newer");
          }
        } catch (e) {
          CONFIG.serverStatus = false;
          log("Config validation/parse error: " + e.message);
          // Don't retry on validation errors, just apply local rules
          applyRules();
          return;
        }
      } else {
        CONFIG.serverStatus = false;

        // Determine if this is a retryable error
        var isRetryable = (statusCode >= 500 || statusCode === 0 || !statusCode); // Server errors, network errors

        if (isRetryable && retryCount < maxRetries) {
          var delay = baseDelay * Math.pow(2, retryCount); // Exponential backoff
          log("Server sync failed (code: " + statusCode + ", error: " + (errorMessage || "N/A") +
              ") - retrying in " + (delay/1000) + "s (attempt " + (retryCount + 1) + "/" + (maxRetries + 1) + ")");

          Timer.set(delay, false, function() {
            attemptSync(retryCount + 1);
          });
        } else {
          if (!isRetryable) {
            log("Server sync failed with non-retryable error (code: " + statusCode + ") - giving up");
          } else {
            log("Max retries reached - giving up");
          }
          // When server is unreachable or returns non-retryable errors, apply local rules
          applyRules();
        }
      }
    });
  }

  // Start the first attempt
  attemptSync(0);

/*
 * sendHeartbeat()
 * ---------------
 * Post a heartbeat to the server with basic device state such as uptime,
 * current relay state and last observed price. The server uses this to
 * update its deviceStatus map and notifications.
 */
function sendHeartbeat() {
  var maxRetries = 2;
  var baseDelay = 5000; // 5 seconds

  function attemptHeartbeat(retryCount) {
    try {
      var heartbeatData = {
        uptime: Shelly.getComponentStatus("sys").uptime,
        switchOn: Shelly.getComponentStatus("switch:0").output,
        lastPrice: CONFIG.lastPrice,
        serverStatus: CONFIG.serverStatus,
        lastSync: CONFIG.lastSync,
        lastConfigUpdate: CONFIG.lastConfigUpdate,
        scriptVersion: SCRIPT_VERSION
      };

      Shelly.call("HTTP.POST", {
        url: CONFIG.serverUrl + "/api/heartbeat/" + CONFIG.deviceId,
        body: JSON.stringify(heartbeatData),
        timeout: 10000 // 10 second timeout
      }, function(result, errorCode, errorMessage) {
        var statusCode = result && result.code !== undefined ? result.code : errorCode;

        if (result && statusCode === 200) {
          log("Heartbeat sent successfully");
        } else {
          var isRetryable = (statusCode >= 500 || statusCode === 0 || !statusCode);

          if (isRetryable && retryCount < maxRetries) {
            var delay = baseDelay * Math.pow(2, retryCount);
            log("Heartbeat failed (code: " + statusCode + ", error: " + (errorMessage || "N/A") +
                ") - retrying in " + (delay/1000) + "s (attempt " + (retryCount + 1) + "/" + (maxRetries + 1) + ")");

            Timer.set(delay, false, function() {
              attemptHeartbeat(retryCount + 1);
            });
          } else {
            if (!isRetryable) {
              log("Heartbeat failed with non-retryable error (code: " + statusCode + ") - giving up");
            } else {
              log("Heartbeat max retries reached - giving up");
            }
          }
        }
      });
    } catch (e) {
      log("Heartbeat preparation error: " + e.message);
    }
  }

  // Start the first attempt
  attemptHeartbeat(0);
}

/*
 * HTTP status endpoint (device-local)
 * ----------------------------------
 * Exposes a tiny HTML page showing current script state and last-known
 * price/schedule information for debugging when connecting directly to the
 * device in a browser.
 */
HTTPServer.registerEndpoint("status", function(req, res) {
  try {
    var html = "<!DOCTYPE html><html><head><title>Shelly " + CONFIG.deviceId + "</title></head><body>";
    html += "<h1>Shelly " + CONFIG.deviceId + " Status</h1>";
    html += "<p>Online: " + (CONFIG.serverStatus ? "Yes" : "No") + "</p>";
    html += "<p>Switch: " + (Shelly.getComponentStatus("switch:0").output ? "ON" : "OFF") + "</p>";
    html += "<p>Override: " + (CONFIG.manualOverride ? "ON" : "OFF") + "</p>";
    html += "<p>Last Price (device): " + (CONFIG.lastPrice || "N/A") + "</p>";
    html += "<p>Server slot price: " + ((typeof CONFIG.serverSlot === 'number' && CONFIG.prices && CONFIG.prices.length > CONFIG.serverSlot) ? CONFIG.prices[CONFIG.serverSlot] : 'N/A') + "</p>";
    html += "<p>Server slot: " + (typeof CONFIG.serverSlot === 'number' ? CONFIG.serverSlot : 'N/A') + "</p>";
    html += "<p>Last Sync: " + (CONFIG.lastSync ? Math.floor(Shelly.getComponentStatus("sys").uptime - CONFIG.lastSync) + "s ago" : "Never") + "</p>";
    html += "<p>Prices: " + (Array.isArray(CONFIG.prices) ? CONFIG.prices.length : 0) + ", Schedule: " + (Array.isArray(CONFIG.schedule) ? CONFIG.schedule.length : 0) + "</p>";

    // Build fallback hours string in a compatibility-safe way
    var fhStr = 'N/A';
    if (Array.isArray(CONFIG.fallbackHours)) {
      var fhParts = [];
      for (var i = 0; i < CONFIG.fallbackHours.length; i++) {
        fhParts.push(i + ': ' + (CONFIG.fallbackHours[i] ? 'ON' : 'OFF'));
      }
      fhStr = fhParts.join(', ');
    }
    html += "<h2>Fallback Hours (local):</h2><p>" + fhStr + "</p>";

    // Build upcoming prices (all known upcoming prices from now)
    // Show them grouped according to CONFIG.timeFrame so the device status
    // displays in the same granularity as scheduling logic (15min/30min/1hour).
    var upcomingHtml = '<p>No known upcoming prices</p>';
    try {
      var startIdx = (typeof CONFIG.serverSlot === 'number' && CONFIG.serverSlot !== null) ? CONFIG.serverSlot : getTimeSlot();
      if (Array.isArray(CONFIG.prices) && CONFIG.prices.length > startIdx) {
        // Map timeFrame to number of 15-min slots per displayed period
        var slotsPerPeriod = 1;
        try {
          if (CONFIG.timeFrame === '30min') slotsPerPeriod = 2;
          else if (CONFIG.timeFrame === '1hour') slotsPerPeriod = 4;
        } catch (e) { slotsPerPeriod = 1; }

        // Compute the first period index to show and how many periods are known
        var firstPeriod = Math.floor(startIdx / slotsPerPeriod);
        // Use ceil so partial final period (when prices length isn't divisible)
        // is included and we'll average available slots for it.
        var totalPeriods = Math.ceil(CONFIG.prices.length / slotsPerPeriod);
        if (totalPeriods <= firstPeriod) {
          // Not enough data for a full period starting at firstPeriod; fall back to per-slot listing
          var fallbackList = [];
          var capSlots = 192;
          for (var kk = startIdx; kk < CONFIG.prices.length && fallbackList.length < capSlots; kk++) {
            var pval = CONFIG.prices[kk];
            fallbackList.push(kk + ': ' + (typeof pval === 'number' ? pval : 'N/A'));
          }
          if (fallbackList.length) upcomingHtml = '<p>' + fallbackList.join(', ') + '</p>';
        } else {
          // Cap number of periods shown to keep the page reasonably sized.
          var capPeriods = Math.ceil(192 / slotsPerPeriod);
          var periodEntries = [];
          for (var p = firstPeriod; p < totalPeriods && periodEntries.length < capPeriods; p++) {
            // aggregate prices for this period (average) using available slots
            var sum = 0;
            var count = 0;
            var startSlot = p * slotsPerPeriod; // in 15-min slots
            var endSlot = Math.min(CONFIG.prices.length - 1, startSlot + slotsPerPeriod - 1);
            for (var idx = startSlot; idx <= endSlot; idx++) {
              var v = CONFIG.prices[idx];
              if (typeof v === 'number' && !isNaN(v)) {
                sum += v;
                count++;
              }
            }
            var avg = (count > 0) ? (sum / count) : null;
            // compute a human-readable UTC time for the start of this period
            // slotWithinDay wraps every 96 slots (24h)
            var dayOffset = Math.floor(startSlot / 96);
            var slotWithinDay = startSlot % 96;
            var hh = Math.floor(slotWithinDay / 4);
            var mm = (slotWithinDay % 4) * 15;
            var hhStr = (hh < 10 ? '0' + hh : '' + hh);
            var mmStr = (mm < 10 ? '0' + mm : '' + mm);
            var daySuffix = dayOffset > 0 ? (' (+ ' + dayOffset + 'd)') : '';
            var timeLabel = hhStr + ':' + mmStr + ' UTC' + daySuffix;
            var displayPrice = (avg !== null) ? (Math.round(avg * 1000) / 1000) : 'N/A';
            periodEntries.push(timeLabel + ': ' + displayPrice);
          }
          if (periodEntries.length) upcomingHtml = '<p>' + periodEntries.join(', ') + '</p>';
        }
      }
    } catch (e) {
      upcomingHtml = '<p>Price list error</p>';
    }
    html += "<h2>Upcoming known prices (from now until known):</h2>" + upcomingHtml;

    html += "</body></html>";
    res.code = 200;
    res.headers = { "Content-Type": "text/html" };
    res.body = html;
    res.send();
  } catch (e) {
    log("Status endpoint error: " + e);
    res.send(500, "text/html", "<html><body><h1>Error</h1><p>" + e + "</p></body></html>");
  }
});

// Lightweight notify endpoint used by server to ask this device to pull
// the full configuration. GET is used because POSTs were observed to be
// reset in some network/firmware setups; GET is more likely to succeed.
HTTPServer.registerEndpoint("notify", function(req, res) {
  try {
    // Trigger an immediate config sync in background
    log('notify received - triggering syncConfig');
    try { syncConfig(); } catch (e) { log('notify->syncConfig error: ' + e); }
    res.code = 200;
    res.headers = { "Content-Type": "application/json" };
    res.body = JSON.stringify({ success: true, message: 'Sync triggered' });
    res.send();
  } catch (e) {
    log('notify endpoint error: ' + e);
    res.send(500, 'application/json', JSON.stringify({ success: false, error: String(e) }));
  }
});

/*
 * HTTP control endpoint (device-local)
 * ------------------------------------
 * Accepts POST commands from the server or manually via the UI to
 * perform actions such as turnOn, turnOff, clearOverride and refreshConfig.
 * Commands are JSON in the request body.
 */
HTTPServer.registerEndpoint("control", function(req, res) {
  try {
    if (req.method === "POST") {
  var command = {};
      try {
        command = JSON.parse(req.body || "{}");
      } catch (e) {
        log("Invalid JSON body: " + e);
        res.code = 400;
        res.headers = { "Content-Type": "application/json" };
        res.body = JSON.stringify({ success: false, error: "Invalid JSON" });
        res.send();
        return;
      }

  var response = { success: true, action: command.action, message: "" };

      if (command.action === "turnOn") {
        CONFIG.manualOverride = true;
        CONFIG.manualState = 'on';
        Shelly.call("Switch.Set", { id: 0, on: true });
        log("Manual ON (state set)");
        response.message = "Turned ON";
        response.switchOn = true;

      } else if (command.action === "turnOff") {
        CONFIG.manualOverride = true;
        CONFIG.manualState = 'off';
        Shelly.call("Switch.Set", { id: 0, on: false });
        log("Manual OFF (state set)");
        response.message = "Turned OFF";
        response.switchOn = false;

      } else if (command.action === "clearOverride") {
        CONFIG.manualOverride = false;
        CONFIG.manualState = null;
        applyRules();
        log("Override cleared (manualState reset)");
        response.message = "Override cleared";
        response.switchOn = Shelly.getComponentStatus("switch:0").output;

      } else if (command.action === "refreshConfig") {
        log("Manual refreshConfig triggered by server");
        syncConfig();
        response.message = "Configuration refresh triggered";

      } else if (command.action === "applyConfig") {
        // Server pushes full config payload. Merge and apply immediately.
        try {
          var newConfig = command.config || {};
          log('applyConfig received from server (len prices=' + (newConfig.prices ? newConfig.prices.length : 0) + ', schedule=' + (newConfig.schedule ? newConfig.schedule.length : 0) + ')');
          // Apply lightweight fields immediately
          if (typeof newConfig.reversedControl !== 'undefined') CONFIG.reversedControl = !!newConfig.reversedControl;
          if (typeof newConfig.manualOverride !== 'undefined') CONFIG.manualOverride = !!newConfig.manualOverride;
          if (typeof newConfig.manualState !== 'undefined') CONFIG.manualState = newConfig.manualState;
          if (typeof newConfig.timeFrame !== 'undefined') CONFIG.timeFrame = newConfig.timeFrame;
          if (Array.isArray(newConfig.prices) && newConfig.prices.length >= 96) CONFIG.prices = newConfig.prices.slice(0, 96);
          if (Array.isArray(newConfig.schedule) && newConfig.schedule.length === 96) CONFIG.schedule = newConfig.schedule.slice(0, 96);
          if (typeof newConfig.serverSlot !== 'undefined') CONFIG.serverSlot = Number(newConfig.serverSlot);
          CONFIG.lastConfigUpdate = newConfig.lastUpdated || new Date().toISOString();
          CONFIG.serverStatus = true;
          CONFIG.lastSync = Shelly.getComponentStatus('sys').uptime;
          // If the pushed config looks valid, apply rules immediately
          if (validateConfig()) {
            applyRules();
            response.message = 'Configuration applied';
            response.applied = true;
          } else {
            log('applyConfig produced invalid config; will preserve prior behavior');
            response.message = 'Configuration received but invalid';
            response.applied = false;
          }
        } catch (e) {
          log('applyConfig error: ' + e);
          response.message = 'applyConfig failed: ' + e;
          response.applied = false;
        }

      } else if (command.action === "applyConfigSummary") {
        // Lightweight summary pushed by server. Apply the quick fields so
        // device can react without pulling the full schedule/prices.
        try {
          var summary = command.summary || {};
          log('applyConfigSummary received from server: ' + JSON.stringify(summary));
          if (typeof summary.reversedControl !== 'undefined') CONFIG.reversedControl = !!summary.reversedControl;
          if (typeof summary.manualOverride !== 'undefined') CONFIG.manualOverride = !!summary.manualOverride;
          if (typeof summary.manualState !== 'undefined') CONFIG.manualState = summary.manualState;
          if (typeof summary.serverSlot !== 'undefined') CONFIG.serverSlot = Number(summary.serverSlot);
          CONFIG.lastConfigUpdate = summary.lastUpdated || CONFIG.lastConfigUpdate;
          CONFIG.serverStatus = true;
          CONFIG.lastSync = Shelly.getComponentStatus('sys').uptime;
          // Apply rules quickly; full config (prices/schedule) may arrive later
          try { applyRules(); } catch (e) { log('applyConfigSummary applyRules error: ' + e); }
          response.message = 'Config summary applied';
          response.applied = true;
        } catch (e) {
          log('applyConfigSummary error: ' + e);
          response.message = 'applyConfigSummary failed: ' + e;
          response.applied = false;
        }

      } else {
        res.code = 400;
        res.headers = { "Content-Type": "application/json" };
        res.body = JSON.stringify({ success: false, error: "Invalid command" });
        res.send();
        return;
      }

      res.code = 200;
      res.headers = { "Content-Type": "application/json" };
      res.body = JSON.stringify(response);
      res.send();

    } else {
      res.code = 405;
      res.headers = { "Content-Type": "application/json" };
      res.body = JSON.stringify({ success: false, error: "Method not allowed" });
      res.send();
    }

  } catch (e) {
    log("Control endpoint error: " + e);
    res.code = 500;
    res.headers = { "Content-Type": "application/json" };
    res.body = JSON.stringify({ success: false, error: "Internal error: " + e });
    res.send();
  }
});

// Initial run
try {
  log("Starting script");
  syncConfig();
  Timer.set(15 * 60 * 1000, true, applyRules); // Apply rules every 15 minutes
  // Sync config periodically. Use 15 minutes to balance responsiveness and server load.
  Timer.set(15 * 60 * 1000, true, syncConfig); // Sync config every 15 minutes
  Timer.set(15 * 60 * 1000, true, sendHeartbeat); // Send heartbeat every 15 minutes
} catch (e) {
  log("Startup error: " + e);
  Shelly.call("Switch.Set", { id: 0, on: false });
}
}