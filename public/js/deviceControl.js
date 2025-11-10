/*
 * Device Control Module
 * ---------------------
 * Handles manual device control operations and status updates
 * for Shelly devices.
 */

/*
 * manualControl(id, action)
 * -------------------------
 * Trigger a manual ON/OFF control for a device via /api/control. Persists
 * the manual override state locally and on the server so the device and UI
 * remain in sync.
 */
async function manualControl(id, action) {
  try {
    const response = await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Control failed');
    console.log(`Manual ${action} for Shelly ${id}`);
    const settings = JSON.parse(localStorage.getItem(`shellySettings_${id}`)) || {};
    // When user presses ON/OFF, enable manual override and record the manualState
    settings.manualOverride = true;
    settings.manualState = action === 'on' ? 'on' : 'off';
    localStorage.setItem(`shellySettings_${id}`, JSON.stringify(settings));
    // Keep the manualOverride checkbox checked and leave manualState reflected in settings
    document.getElementById(`manualOverride${id}`).checked = true;
    // Save to server
    await fetch('/api/save-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, settings })
    });
    // Sync rules to Shelly
    await fetch('/api/sync-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, rules: settings })
    });

    // Update UI immediately to reflect manual state
    try {
      const prices = await window.ChartModule.fetchPrices();
      const rawPricesInfo = window.ChartModule.getRawPricesInfo(prices);
      const { states, labels, rawLabels } = window.ChartModule.calculateShellyStates(rawPricesInfo, settings, settings.manualOverride);
      window.ChartModule.renderShellyStateChart(id, states, labels, rawLabels, rawPricesInfo.currentSlotIndex, settings.timeFrame);
      updateShellyStatus(id);
    } catch (e) {
      console.warn('Failed to refresh UI after manual control:', e);
    }
  } catch (error) {
    console.error('Manual control failed:', error.message);
  }
}

/*
 * updateShellyStatus(id)
 * ----------------------
 * Fetch `/api/status` (aggregated device statuses) and update the UI
 * elements for the given device id. Also updates the per-device state chart
 * current-period highlight and logical/physical relay text.
 */
// updateShellyStatus(id, overrideStatus)
// If overrideStatus is provided, use it directly (useful after an on-demand
// device query). Otherwise fetch aggregated `/api/status` once per call.
async function updateShellyStatus(id, overrideStatus) {
  try {
    let status = overrideStatus;
    if (!status) {
      const response = await fetch('/api/status');
      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
      const allStatuses = await response.json();
      status = allStatuses[id];
    }

    if (!status) {
      throw new Error(`No status data for Shelly ${id}`);
    }

    const statusElement = document.getElementById(`statusIndicator${id}`).querySelector('.status-text');
    console.log(`Shelly ${id} status:`, status); // Debug log to verify status data

    // Format lastHeartbeat and lastSync as relative time
    const now = new Date();
    const lastHeartbeat = status.lastHeartbeat ? new Date(status.lastHeartbeat) : null;
    const lastSync = status.lastSync ? new Date(status.lastSync) : null;
    const formatRelativeTime = (date) => {
      if (!date) return 'Never';
      const diffSeconds = Math.floor((now - date) / 1000);
      if (diffSeconds < 60) return `${diffSeconds}s ago`;
      if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
      return `${Math.floor(diffSeconds / 3600)}h ago`;
    };

    // Determine logical state according to settings and price-driven schedule.
    // The server `status.switchOn` is the physical relay position; when
    // `reversedControl` is enabled we want the main Status and the state bars
    // to reflect the logical (user-facing) state while still showing the
    // physical state separately in the relayState element.
    let logicalDisplay = 'Unknown';
    let logicalIsOn = null;
    try {
      const settings = JSON.parse(localStorage.getItem(`shellySettings_${id}`)) || {};
      const rpi = window.rawPricesInfo;
      if (settings && settings.manualOverride && settings.manualState) {
        logicalDisplay = settings.manualState === 'on' ? 'ON' : 'OFF';
        logicalIsOn = settings.manualState === 'on';
      } else if (rpi) {
        try {
          const calc = window.ChartModule.calculateShellyStates(rpi, settings || {}, settings ? settings.manualOverride : false);
          const timeFrame = settings.timeFrame || '15min';
          const slotsPerPeriod = timeFrame === '1hour' ? 4 : timeFrame === '30min' ? 2 : 1;
          const currentIdx = rpi.currentSlotIndex >= 0 ? Math.floor(rpi.currentSlotIndex / slotsPerPeriod) : -1;
          const idx = currentIdx >= 0 && currentIdx < calc.states.length ? currentIdx : 0;
          logicalDisplay = calc.states[idx] === 1 ? 'ON' : 'OFF';
          logicalIsOn = calc.states[idx] === 1;
        } catch (e) {
          logicalDisplay = 'Unknown';
          logicalIsOn = null;
        }
      }
    } catch (e) {
      logicalDisplay = 'Unknown';
      logicalIsOn = null;
    }

    if (status.online) {
      // Show both logical (user-facing) and physical (relay) states together.
      // Logical is derived from settings+prices; physical is device-reported.
      const physicalDisplay = status.switchOn ? 'ON' : 'OFF';
      statusElement.textContent = `Online (Logical: ${logicalDisplay} · Physical: ${physicalDisplay}, Price: ${status.lastPrice || 'N/A'}, Last Sync: ${formatRelativeTime(lastSync)}, Last Heartbeat: ${formatRelativeTime(lastHeartbeat)})`;
      // Use logical state to pick a visual class (green when logical ON)
      statusElement.className = `status-text ${logicalIsOn ? 'online' : 'offline'}`;
    } else if (status.error) {
      statusElement.textContent = `Error: ${status.error} (${status.switchOn ? 'ON' : 'OFF'}, Last Heartbeat: ${formatRelativeTime(lastHeartbeat)})`;
      statusElement.className = 'status-text error';
    } else {
      // When offline, still show the last-known physical state to aid debugging
      statusElement.textContent = `Offline (${status.switchOn ? 'ON' : 'OFF'}, Last Heartbeat: ${formatRelativeTime(lastHeartbeat)})`;
      statusElement.className = 'status-text offline';
    }

    // Reflect actual device switch state on the current period bar in the state chart (if chart exists)
    try {
      const chart = window.ChartModule.stateCharts[id];
      if (chart && Chart && Chart.getChart) {
        // Determine current period index. Prefer exact ISO-match against the chart's
        // stored rawLabels (prevents marking the same HH:MM on a different day).
        const settings = JSON.parse(localStorage.getItem(`shellySettings_${id}`)) || {};
        const timeFrame = settings.timeFrame || '15min';
        const slotsPerPeriod = timeFrame === '1hour' ? 4 : timeFrame === '30min' ? 2 : 1;

        let idx = -1;
        try {
          const rpi = window.rawPricesInfo;
          if (rpi && typeof rpi.currentSlotIndex === 'number' && rpi.currentSlotIndex >= 0 && chart._rawLabels) {
            const currentIso = rpi.combinedLabels[rpi.currentSlotIndex];
            idx = chart._rawLabels.indexOf(currentIso);
          }
        } catch (e) {
          console.warn('Failed to map current ISO to chart index:', e);
          idx = -1;
        }

        // Fallback: derive from local time if ISO mapping didn't work
        if (idx === -1) {
          const now = new Date();
          const utcHours = now.getUTCHours();
          const utcMinutes = now.getUTCMinutes();
          const slotIndex = utcHours * 4 + Math.floor(utcMinutes / 15); // 0-95
          const currentPeriodIndex = Math.floor(slotIndex / slotsPerPeriod);
          const maxIndex = chart.data.labels.length - 1;
          idx = Math.min(currentPeriodIndex, maxIndex);
        }

        // compute colors consistent with renderShellyStateChart
        const rootStyles = getComputedStyle(document.documentElement);
        const primaryColor = rootStyles.getPropertyValue('--primary-color').trim() || '#00ff00';
        const offColor = rootStyles.getPropertyValue('--off-color').trim() || '#808080';
        const currentBorderColor = rootStyles.getPropertyValue('--current-color').trim() || '#ff0000';

        // Update only the current period visuals to reflect real device state
        const bg = chart.data.datasets[0].backgroundColor.slice();
        const border = chart.data.datasets[0].borderColor.slice();
        const borderW = chart.data.datasets[0].borderWidth.slice ? chart.data.datasets[0].borderWidth.slice() : [];

        // Ensure arrays have correct length
        for (let i = 0; i <= idx; i++) {
          if (bg[i] === undefined) bg[i] = offColor;
          if (border[i] === undefined) border[i] = offColor;
          if (borderW[i] === undefined) borderW[i] = 1;
        }

        // Use logical state to color the current period so the chart reflects
        // the user's intended ON/OFF (respecting reversedControl), while the
        // relayState element continues to show the physical relay.
        const paintOn = (typeof logicalIsOn === 'boolean') ? logicalIsOn : status.switchOn;
        bg[idx] = paintOn ? primaryColor : offColor;
        border[idx] = idx === Math.floor(idx) ? currentBorderColor : (paintOn ? primaryColor : offColor);
        borderW[idx] = 2;

        chart.data.datasets[0].backgroundColor = bg;
        chart.data.datasets[0].borderColor = border;
        chart.data.datasets[0].borderWidth = borderW;
        chart.update();
      }
    } catch (e) {
      console.warn('Failed to update state chart with actual device state:', e);
    }

    // Update logical vs physical relay state display (if present)
    try {
      const relayEl = document.getElementById(`relayState${id}`);
      if (relayEl) {
        // Determine logical state using latest prices info when available
        const settings = JSON.parse(localStorage.getItem(`shellySettings_${id}`)) || {};
        let logicalDisplay = 'Unknown';
        const rpi = window.rawPricesInfo;
        if (settings && settings.manualOverride && settings.manualState) {
          logicalDisplay = settings.manualState === 'on' ? 'ON' : 'OFF';
        } else if (rpi) {
          try {
            const calc = window.ChartModule.calculateShellyStates(rpi, settings || {}, settings ? settings.manualOverride : false);
            // determine appropriate index for current period based on timeframe
            const slotsPerPeriod = settings && settings.timeFrame === '1hour' ? 4 : settings && settings.timeFrame === '30min' ? 2 : 1;
            const currentIdx = rpi.currentSlotIndex >= 0 ? Math.floor(rpi.currentSlotIndex / slotsPerPeriod) : -1;
            const idx = currentIdx >= 0 && currentIdx < calc.states.length ? currentIdx : 0;
            logicalDisplay = calc.states[idx] === 1 ? 'ON' : 'OFF';
          } catch (e) {
            logicalDisplay = 'Unknown';
          }
        }

        const physicalDisplay = status.switchOn ? 'ON' : 'OFF';
        const revNote = (settings && settings.reversedControl) ? ' (reversed)' : '';
        relayEl.textContent = `Logical: ${logicalDisplay}  ·  Physical: ${physicalDisplay}${revNote}`;
      }
    } catch (e) {
      // non-critical UI update failure
    }
  } catch (error) {
    console.error(`Failed to fetch status for Shelly ${id}:`, error.message);
    const statusElement = document.getElementById(`statusIndicator${id}`).querySelector('.status-text');
    statusElement.textContent = `Error: ${error.message} (Unknown)`;
    statusElement.className = 'status-text error';
  }
}

// Export functions for use in other modules
window.DeviceControlModule = {
  manualControl,
  updateShellyStatus
};