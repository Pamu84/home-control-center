/*
 * UI Module
 * ---------
 * Handles UI-specific functionality including timezone settings
 * and main application initialization.
 */

/*
 * setUiTimezone(tz)
 * -----------------
 * Update the global UI timezone and trigger UI refresh for charts
 * and device state displays.
 */
function setUiTimezone(tz) {
  try {
    window.ChartModule.UI_TIMEZONE = tz || window.ChartModule.UI_TIMEZONE;
    localStorage.setItem('uiTimeZone', window.ChartModule.UI_TIMEZONE);
    // Trigger immediate UI refresh where possible
    try {
      if (window.lastFetchedPrices) window.ChartModule.renderChart(window.lastFetchedPrices, document.getElementById('chartTimeFrame').value || '15min');
    } catch (e) {}
    try {
      // Recompute and redraw per-device charts
      const containers = document.querySelectorAll('.shelly-container');
      const rpi = window.rawPricesInfo;
      containers.forEach(container => {
        const id = container.dataset.id;
        const settings = JSON.parse(localStorage.getItem(`shellySettings_${id}`)) || {};
        if (rpi) {
          const { states, labels, rawLabels } = window.ChartModule.calculateShellyStates(rpi, settings, settings.manualOverride);
          window.ChartModule.renderShellyStateChart(id, states, labels, rawLabels, rpi.currentSlotIndex, settings.timeFrame);
        }
        // Update status panel text
        try { window.DeviceControlModule.updateShellyStatus(id); } catch (e) {}
      });
    } catch (e) {}
  } catch (e) { console.warn('Failed to set UI timezone:', e); }
}

/*
 * Main application initialization
 * -------------------------------
 * Sets up the application when the DOM is ready, including
 * price fetching, chart rendering, device container creation,
 * and periodic UI updates.
 */
(async function init() {
  try {
    const prices = await window.ChartModule.fetchPrices();
    // Fetch available features and hide Video Surveillance tab when cameras not enabled
    try {
      const featRes = await fetch('/api/features');
      if (featRes.ok) {
        const feats = await featRes.json();
        const camerasFeature = feats.find(f => f.id === 'cameras');
        if (!camerasFeature || !camerasFeature.enabled) {
          const videoTabBtn = document.querySelector('.tab-button[data-tab="video-surveillance"]');
          if (videoTabBtn) videoTabBtn.style.display = 'none';
          const videoPane = document.getElementById('video-surveillance');
          if (videoPane) videoPane.style.display = 'none';
        }
      }
    } catch (e) {
      // If /api/features missing, fall back to legacy behavior (show tab)
      console.warn('Feature discovery failed, keeping legacy Video tab visible:', e.message);
    }
    let chartTimeFrame = localStorage.getItem('chartTimeFrame') || '15min';
    document.getElementById('chartTimeFrame').value = chartTimeFrame;
    // Keep the last fetched prices so timezone changes can re-render the chart
    window.lastFetchedPrices = prices;
    const rawPricesInfo = window.ChartModule.getRawPricesInfo(prices);
    window.rawPricesInfo = rawPricesInfo;
    // Initialize timezone selector from localStorage
    try {
      const tzEl = document.getElementById('timezoneSelect');
      if (tzEl) {
        tzEl.value = localStorage.getItem('uiTimeZone') || window.ChartModule.UI_TIMEZONE;
        tzEl.addEventListener('change', (e) => {
          setUiTimezone(e.target.value);
        });
      }
    } catch (e) { console.warn('Failed to initialize timezone select:', e); }
    window.ChartModule.renderChart(prices, chartTimeFrame);

    // Add event listener for chart time frame changes
    document.getElementById('chartTimeFrame').addEventListener('change', async (e) => {
      chartTimeFrame = e.target.value;
      localStorage.setItem('chartTimeFrame', chartTimeFrame);
      const freshPrices = await window.ChartModule.fetchPrices();
      window.ChartModule.renderChart(freshPrices, chartTimeFrame);
    });

    // Fetch runtime settings (including shellyDevices) and dynamically add any missing Shelly containers
    async function ensureShellyContainers() {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const settingsResp = await res.json();
        // expose server-side camera definitions for UI initialization
        window.serverVideoCameras = settingsResp.videoCameras || {};
        const devices = settingsResp.shellyDevices || {};
        const currentConfigHash = JSON.stringify(devices);

        // Check if configuration changed
        if (window.lastShellyConfigHash !== currentConfigHash) {
          console.log('Shelly device configuration changed, updating UI');
          window.lastShellyConfigHash = currentConfigHash;
          window.currentShellyConfigHash = currentConfigHash;
        }

        const containerRoot = document.getElementById('shelly-devices-root') || document.getElementById('shelly-devices');
        for (const [id, ip] of Object.entries(devices)) {
          if (!document.querySelector(`.shelly-container[data-id="${id}"]`)) {
            // Build container
            const container = document.createElement('div');
            container.className = 'shelly-container';
            container.dataset.id = id;
            let displayName = `Shelly ${id}`;
            let descriptionText = '';
            if (ip && typeof ip === 'object') {
              displayName = ip.name || `Shelly ${id}`;
              descriptionText = ip.description || '';
            }
            container.innerHTML = `
              <h3>${displayName}</h3>
              ${descriptionText ? `<div class="shelly-description">${descriptionText}</div>` : ''}
              <div class="status-indicator" id="statusIndicator${id}">
                Status: <span class="status-text">Checking...</span>
              </div>

              <canvas id="stateChart${id}" width="800" height="200"></canvas>
              <form class="shelly-form">
                <label>
                  Manual Override:
                  <input type="checkbox" id="manualOverride${id}">
                </label>
                  <label>
                    Reversed Control:
                    <input type="checkbox" id="reversedControl${id}">
                    <span class="help" title="When checked, logical ON means the physical relay is switched OFF (use for normally-closed wiring).">?</span>
                  </label>
                  <div class="relay-state" id="relayState${id}" style="margin-top:6px;font-size:0.95em;color:#333">Logical: -  ·  Physical: -</div>
                <label>
                  Min Price (c/kWh):
                  <input type="number" id="minPrice${id}" step="0.01" min="0">
                </label>
                <label>
                  Max Price (c/kWh):
                  <input type="number" id="maxPrice${id}" step="0.01" min="0">
                </label>
                <label>
                  Cheapest Slots:
                  <input type="number" id="numCheapest${id}" min="0">
                </label>
                <label>
                  Time Frame:
                  <select id="timeFrame${id}">
                    <option value="15min">15 Minutes</option>
                    <option value="30min">30 Minutes</option>
                    <option value="1hour">1 Hour</option>
                  </select>
                </label>

                <button type="submit">Save Settings</button>
                  <button type="button" onclick="window.DeviceControlModule.manualControl('${id}', 'on')">Turn ON</button>
                  <button type="button" onclick="window.DeviceControlModule.manualControl('${id}', 'off')">Turn OFF</button>
              </form>
            `;
            containerRoot.appendChild(container);

          }
        }
      } catch (err) {
        console.warn('Could not load shellyDevices from /api/settings:', err.message);
      }
    }

    await ensureShellyContainers();

    // Function to initialize a Shelly container with settings and event handlers
    async function initializeShellyContainer(container) {
      const id = container.dataset.id;
      const form = container.querySelector('.shelly-form');

      // Load settings from server and merge with localStorage
      let savedSettings = await window.SettingsModule.loadSettingsFromServer(id);
      const localSettings = JSON.parse(localStorage.getItem(`shellySettings_${id}`)) || {};
      savedSettings = { ...savedSettings, ...localSettings, id }; // Merge, prefer local, ensure id
      savedSettings.fallbackHours = savedSettings.fallbackHours || Array(24).fill(false);
      localStorage.setItem(`shellySettings_${id}`, JSON.stringify(savedSettings));

      // Set form values
      form.querySelector(`#minPrice${id}`).value = savedSettings.minPrice || 0.05;
      form.querySelector(`#maxPrice${id}`).value = savedSettings.maxPrice || 0.20;
      form.querySelector(`#numCheapest${id}`).value = savedSettings.numCheapest || 4;
      form.querySelector(`#manualOverride${id}`).checked = !!savedSettings.manualOverride;
      form.querySelector(`#reversedControl${id}`).checked = !!savedSettings.reversedControl;
      if (savedSettings.manualState) {
        form.querySelector(`#manualOverride${id}`).dataset.manualState = savedSettings.manualState;
      } else {
        form.querySelector(`#manualOverride${id}`).removeAttribute('data-manual-state');
      }
      form.querySelector(`#timeFrame${id}`).value = savedSettings.timeFrame || '15min';

      // Add fallback UI if not present
      if (!form.querySelector('.fallback-settings')) {
        const fallbackDiv = document.createElement('div');
        fallbackDiv.className = 'fallback-settings';
        fallbackDiv.innerHTML = '<h4>Fallback Hourly Settings (used when no prices available)</h4><div class="hours-grid"></div>';
        const hoursGrid = fallbackDiv.querySelector('.hours-grid');
        for (let h = 0; h < 24; h++) {
          const label = document.createElement('label');
          label.textContent = `${h.toString().padStart(2, '0')}:00 `;
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.name = `fallbackHour${h}`;
          input.checked = savedSettings.fallbackHours[h];
          label.appendChild(input);
          hoursGrid.appendChild(label);
        }
        form.appendChild(fallbackDiv);
      }

      // Initial status check
      window.DeviceControlModule.updateShellyStatus(id);

      const { states, labels, rawLabels } = window.ChartModule.calculateShellyStates(rawPricesInfo, savedSettings, savedSettings.manualOverride);
      window.ChartModule.renderShellyStateChart(id, states, labels, rawLabels, rawPricesInfo.currentSlotIndex, savedSettings.timeFrame);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fallbackHours = Array(24).fill(false);
        for (let h = 0; h < 24; h++) {
          fallbackHours[h] = form.querySelector(`input[name="fallbackHour${h}"]`).checked;
        }
        const settings = {
          id,
          minPrice: form.querySelector(`#minPrice${id}`).value,
          maxPrice: form.querySelector(`#maxPrice${id}`).value,
          numCheapest: form.querySelector(`#numCheapest${id}`).value,
          manualOverride: form.querySelector(`#manualOverride${id}`).checked,
          reversedControl: form.querySelector(`#reversedControl${id}`).checked,
          timeFrame: form.querySelector(`#timeFrame${id}`).value,
          fallbackHours
        };

        localStorage.setItem(`shellySettings_${id}`, JSON.stringify(settings));
        await window.SettingsModule.saveSettingsToServer(id, settings);
        console.log(`Settings saved for Shelly ${id}:`, settings);
        // Push settings to server and prompt device to refresh immediately
        try {
          await window.SettingsModule.syncRulesToShelly(id, settings);
          // show a small inline confirmation so user knows device was prompted
          let note = form.querySelector('.sync-note');
          if (!note) {
            note = document.createElement('div');
            note.className = 'sync-note';
            note.style.marginTop = '8px';
            note.style.fontSize = '0.9em';
            note.style.color = '#006400';
            form.appendChild(note);
          }
          note.textContent = 'Settings saved and pushed to device (device will refresh shortly).';
          setTimeout(() => { try { note.textContent = ''; } catch (e) {} }, 6000);
        } catch (e) {
          console.warn('Failed to push settings to device:', e);
        }

        const { states, labels, rawLabels } = window.ChartModule.calculateShellyStates(rawPricesInfo, settings, settings.manualOverride);
        window.ChartModule.renderShellyStateChart(id, states, labels, rawLabels, rawPricesInfo.currentSlotIndex, settings.timeFrame);
        window.DeviceControlModule.updateShellyStatus(id); // Update status after settings change
      });

      form.querySelector(`#manualOverride${id}`).addEventListener('change', async (e) => {
        const settings = JSON.parse(localStorage.getItem(`shellySettings_${id}`)) || {};
        // When user unchecks manual override, revert to scheduled behaviour and clear manualState
        if (!e.target.checked) {
          settings.manualOverride = false;
          delete settings.manualState;
        } else {
          // When user checks manual override from UI (without pressing ON/OFF), enable override but don't change manualState
          settings.manualOverride = true;
          // leave settings.manualState as-is if present; do not set it to 'on' automatically
        }
        localStorage.setItem(`shellySettings_${id}`, JSON.stringify(settings));
        await window.SettingsModule.saveSettingsToServer(id, settings);
        // Prompt device to refresh immediately
        try { await window.SettingsModule.syncRulesToShelly(id, settings); } catch (e) { console.warn('Failed to push manualOverride change to device:', e); }
        const { states, labels, rawLabels } = window.ChartModule.calculateShellyStates(rawPricesInfo, settings, settings.manualOverride);
        window.ChartModule.renderShellyStateChart(id, states, labels, rawLabels, rawPricesInfo.currentSlotIndex, settings.timeFrame);
        window.DeviceControlModule.updateShellyStatus(id); // Update status after manual override change
      });
      // Reversed control change: persist immediately
      form.querySelector(`#reversedControl${id}`).addEventListener('change', async (e) => {
        const settings = JSON.parse(localStorage.getItem(`shellySettings_${id}`)) || {};
        settings.reversedControl = !!e.target.checked;
        localStorage.setItem(`shellySettings_${id}`, JSON.stringify(settings));
        await window.SettingsModule.saveSettingsToServer(id, settings);
        // Try to fetch the latest device status on-demand and update the UI
        // immediately so the relay/logical state reflects recent changes.
        try {
          const resp = await fetch(`/api/shelly-status/${id}`);
          if (resp.ok) {
            const deviceStatus = await resp.json();
            window.DeviceControlModule.updateShellyStatus(id, deviceStatus);
          } else {
            // fallback to regular aggregated status refresh
            window.DeviceControlModule.updateShellyStatus(id);
          }
        } catch (err) {
          console.warn('Failed to fetch on-demand shelly-status:', err);
          window.DeviceControlModule.updateShellyStatus(id);
        }
      });
    }

    await ensureShellyContainers();

    const shellyForms = document.querySelectorAll('.shelly-container');
    shellyForms.forEach(async (container) => {
      await initializeShellyContainer(container);
      container.dataset.initialized = 'true'; // Mark as initialized
    });
    // Use a 30-second UI poll interval to balance responsiveness with user experience.
    // We fetch `/api/status` once per tick and pass the per-device entries to
    // `updateShellyStatus` to avoid redundant network requests.
    let lastDeviceCount = 0;
    setInterval(async () => {
      try {
        const freshPrices = await window.ChartModule.fetchPrices();
        // update last fetched prices for potential timezone re-renders
        window.lastFetchedPrices = freshPrices;
        const freshRawPricesInfo = window.ChartModule.getRawPricesInfo(freshPrices);
        window.rawPricesInfo = freshRawPricesInfo;
        window.ChartModule.renderChart(freshPrices, chartTimeFrame);

        // Check for new devices and ensure containers exist
        await ensureShellyContainers();

        // Check if device count changed (new devices added) or configuration changed
        const currentDeviceCount = document.querySelectorAll('.shelly-container').length;
        const configChanged = window.lastShellyConfigHash !== window.currentShellyConfigHash;
        if (currentDeviceCount !== lastDeviceCount || configChanged) {
          console.log(`Device configuration changed (count: ${lastDeviceCount} -> ${currentDeviceCount}, config changed: ${configChanged}), initializing new containers`);
          lastDeviceCount = currentDeviceCount;
          window.lastShellyConfigHash = window.currentShellyConfigHash;
          // Initialize any newly added containers
          const allContainers = document.querySelectorAll('.shelly-container');
          for (const container of allContainers) {
            const id = container.dataset.id;
            // Check if this container has been initialized (has event listeners)
            if (!container.dataset.initialized) {
              await initializeShellyContainer(container);
              container.dataset.initialized = 'true';
            }
          }
        }        // Fetch aggregated device statuses once and reuse for each panel
        let allStatuses = {};
        try {
          const sresp = await fetch('/api/status');
          if (sresp.ok) allStatuses = await sresp.json();
        } catch (e) {
          console.warn('Failed to fetch /api/status during periodic update:', e);
        }

        // Get updated list of containers (including any newly added ones)
        const shellyForms = document.querySelectorAll('.shelly-container');
        shellyForms.forEach(async container => {
          const id = container.dataset.id;
          const settings = JSON.parse(localStorage.getItem(`shellySettings_${id}`));
          if (settings) {
            const { states, labels, rawLabels } = window.ChartModule.calculateShellyStates(freshRawPricesInfo, settings, settings.manualOverride);
            window.ChartModule.renderShellyStateChart(id, states, labels, rawLabels, freshRawPricesInfo.currentSlotIndex, settings.timeFrame);
            // Provide the pre-fetched status for faster UI updates
            window.DeviceControlModule.updateShellyStatus(id, allStatuses[id]);
          } else {
            // If no settings exist, try to load them and update the UI
            try {
              const serverSettings = await window.SettingsModule.loadSettingsFromServer(id);
              if (serverSettings && Object.keys(serverSettings).length > 0) {
                localStorage.setItem(`shellySettings_${id}`, JSON.stringify(serverSettings));
                const { states, labels, rawLabels } = window.ChartModule.calculateShellyStates(freshRawPricesInfo, serverSettings, serverSettings.manualOverride);
                window.ChartModule.renderShellyStateChart(id, states, labels, rawLabels, freshRawPricesInfo.currentSlotIndex, serverSettings.timeFrame);
                window.DeviceControlModule.updateShellyStatus(id, allStatuses[id]);
              }
            } catch (e) {
              console.warn(`Failed to load settings for device ${id}:`, e);
            }
          }
        });

        // Update last update time
        const now = new Date();
        const timeString = now.toLocaleTimeString();
        const lastUpdateElement = document.getElementById('lastUpdateTime');
        if (lastUpdateElement) {
          lastUpdateElement.textContent = timeString;
        }
      } catch (e) {
        console.warn('Periodic UI update failed:', e);
      }
    }, 30000); // Refresh every 30 seconds instead of 10
  } catch (error) {
    console.error('Error loading chart:', error);
  }

  // Global refresh function for manual UI updates
  window.refreshAllUI = async function() {
    try {
      console.log('Manually refreshing all UI elements...');
      const freshPrices = await window.ChartModule.fetchPrices();
      window.lastFetchedPrices = freshPrices;
      const freshRawPricesInfo = window.ChartModule.getRawPricesInfo(freshPrices);
      window.rawPricesInfo = freshRawPricesInfo;
      window.ChartModule.renderChart(freshPrices, chartTimeFrame);

      await ensureShellyContainers();

      let allStatuses = {};
      try {
        const sresp = await fetch('/api/status');
        if (sresp.ok) allStatuses = await sresp.json();
      } catch (e) {
        console.warn('Failed to fetch /api/status during manual refresh:', e);
      }

      const shellyForms = document.querySelectorAll('.shelly-container');
      shellyForms.forEach(async container => {
        const id = container.dataset.id;
        const settings = JSON.parse(localStorage.getItem(`shellySettings_${id}`));
        if (settings) {
          const { states, labels, rawLabels } = window.ChartModule.calculateShellyStates(freshRawPricesInfo, settings, settings.manualOverride);
          window.ChartModule.renderShellyStateChart(id, states, labels, rawLabels, freshRawPricesInfo.currentSlotIndex, settings.timeFrame);
          window.DeviceControlModule.updateShellyStatus(id, allStatuses[id]);
        }
      });
      console.log('Manual UI refresh completed');

      // Update last update time
      const now = new Date();
      const timeString = now.toLocaleTimeString();
      const lastUpdateElement = document.getElementById('lastUpdateTime');
      if (lastUpdateElement) {
        lastUpdateElement.textContent = timeString;
      }
    } catch (e) {
      console.error('Manual UI refresh failed:', e);
    }
  };
})();

// Export functions for use in other modules
window.UIModule = {
  setUiTimezone
};