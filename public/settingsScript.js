/*
 * loadSettings()
 * --------------
 * Fetch global runtime settings from the server and populate the settings
 * form fields (watchdogInterval, priceFetchInterval). Called on page load.
 */
async function loadSettings() {
const res = await fetch('/api/settings');
const data = await res.json();
document.getElementById('watchdogInterval').value = data.watchdogInterval;
document.getElementById('priceFetchInterval').value = data.priceFetchInterval;
}

/*
 * loadUserPreferences()
 * ---------------------
 * Load user preferences (timezone, locale, timeFormat) and populate the UI.
 */
async function loadUserPreferences() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.userPreferences) {
      document.getElementById('timezoneSelect').value = data.userPreferences.timezone || 'Europe/Helsinki';
      document.getElementById('localeSelect').value = data.userPreferences.locale || 'fi-FI';
      document.getElementById('timeFormatSelect').value = data.userPreferences.timeFormat || '24h';
    }
  } catch (e) {
    console.warn('Failed to load user preferences:', e.message);
  }
}

/*
 * saveUserPreferences()
 * ---------------------
 * Save user preferences to the server.
 */
async function saveUserPreferences() {
  try {
    const timezone = document.getElementById('timezoneSelect').value;
    const locale = document.getElementById('localeSelect').value;
    const timeFormat = document.getElementById('timeFormatSelect').value;
    
    const res = await fetch('/api/user-preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone, locale, timeFormat })
    });
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    console.log('User preferences saved:', result);
    
    // Update global variables and refresh UI
    if (window.ChartModule) {
      window.ChartModule.UI_TIMEZONE = timezone;
      window.ChartModule.UI_LOCALE = locale;
      window.ChartModule.UI_TIME_FORMAT = timeFormat;
      localStorage.setItem('uiTimeZone', timezone);
    }
    
    // Refresh charts if prices are loaded
    if (window.lastFetchedPrices) {
      window.ChartModule.renderChart(window.lastFetchedPrices, document.getElementById('chartTimeFrame').value || '15min');
    }
    
  } catch (e) {
    console.error('Failed to save user preferences:', e.message);
    alert('Failed to save preferences. Please try again.');
  }
}

/* load motion recording flag and other settings */
async function loadMotionRecordingFlag() {
    try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        const enabled = typeof data.motionRecordingEnabled === 'undefined' ? true : !!data.motionRecordingEnabled;
        document.getElementById('motionRecordingEnabled').checked = enabled;
    } catch (e) {
        console.warn('Failed to load motion recording flag:', e.message);
    }
}

/* load audio recording flag */
async function loadAudioRecordingFlag() {
    try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        const enabled = typeof data.audioRecordingEnabled === 'undefined' ? false : !!data.audioRecordingEnabled;
        document.getElementById('audioRecordingEnabled').checked = enabled;
    } catch (e) {
        console.warn('Failed to load audio recording flag:', e.message);
    }
}

/*
 * loadDevicesList()
 * ------------------
 * Retrieve the runtime shellyDevices mapping and render a simple list in
 * the UI. Each list entry exposes Update and Remove controls that call the
 * server API to mutate the runtime config.
 */
async function loadDevicesList() {
    const listRoot = document.getElementById('devicesList');
    try {
        const res = await fetch('/api/settings');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const devices = data.shellyDevices || {};
        if (Object.keys(devices).length === 0) {
            listRoot.textContent = 'No Shelly devices configured.';
            return;
        }
        // Build list
        listRoot.innerHTML = '';
        const ul = document.createElement('ul');
            for (const [id, info] of Object.entries(devices)) {
                    const li = document.createElement('li');
                    const display = (info && typeof info === 'object') ? `${info.name || 'Shelly'} (${info.ip || ''})` : String(info);
                    li.textContent = `ID: ${id} — ${display}`;
                // Remove button
                const btn = document.createElement('button');
                btn.textContent = 'Remove';
                btn.style.marginLeft = '10px';
                btn.addEventListener('click', async () => {
                    if (!confirm(`Remove Shelly ${id}?`)) return;
                    const del = await fetch(`/api/shelly/${id}`, { method: 'DELETE' });
                    const text = await del.text();
                    alert(text);
                    if (del.ok) {
                        // Refresh UI and device containers
                        await loadDevicesList();
                        window.location.reload();
                    }
                });
                li.appendChild(btn);

                // Update button (prompt-based inline update)
                const upd = document.createElement('button');
                upd.textContent = 'Update';
                upd.style.marginLeft = '6px';
                upd.addEventListener('click', async () => {
                                    const currentName = (info && typeof info === 'object') ? (info.name || '') : '';
                                    const currentIp = (info && typeof info === 'object') ? (info.ip || '') : String(info);
                                    const currentDescription = (info && typeof info === 'object') ? (info.description || '') : '';
                    const newName = prompt('New name for Shelly', currentName || `Shelly ${id}`);
                    if (newName === null) return; // cancelled
                    const newIp = prompt('New IP/hostname for Shelly', currentIp || '');
                    if (newIp === null) return;
                    const newDescription = prompt('New description for Shelly (optional)', currentDescription || '');
                    if (newDescription === null) return;
                    // Client-side validation
                    if (!isValidHost(newIp)) { alert('Invalid IP/hostname'); return; }
                    try {
                        const put = await fetch(`/api/shelly/${id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: newName, ip: newIp, description: newDescription })
                        });
                        const t = await put.text();
                        alert(t);
                        if (put.ok) {
                            await loadDevicesList();
                            window.location.reload();
                        }
                    } catch (err) {
                        alert('Failed to update device: ' + err.message);
                    }
                });
                li.appendChild(upd);
                // Show script button (manual upload)
                const uploadBtn = document.createElement('button');
                uploadBtn.textContent = 'Show Script';
                uploadBtn.style.marginLeft = '6px';
                uploadBtn.addEventListener('click', async () => {
                    showUploadModal(`Fetching script for Shelly ${id} (${info.ip || ''})...`);
                    try {
                        const rsp = await fetch(`/api/get-script?id=${encodeURIComponent(id)}`);
                        const json = await rsp.json();
                        if (rsp.ok && json && json.success && json.script) {
                            showUploadModal(`Script ready for Shelly ${id}. Copy and paste into device web UI: http://${info.ip || '<device-ip>'}/#/script/1`, json.script);
                        } else {
                            const err = (json && json.error) ? json.error : 'Failed to fetch script';
                            showUploadModal('Failed to fetch script: ' + err);
                        }
                    } catch (err) {
                        showUploadModal('Request failed: ' + err.message);
                    }
                });
                li.appendChild(uploadBtn);
                // Open Shelly UI button: opens the device's script editor in a new tab
                const openBtn = document.createElement('button');
                openBtn.textContent = 'Open Shelly UI';
                openBtn.style.marginLeft = '6px';
                openBtn.addEventListener('click', () => {
                    const targetIp = info && typeof info === 'object' ? (info.ip || '<device-ip>') : '<device-ip>';
                    const url = `http://${targetIp}/#/script/1`;
                    try {
                        window.open(url, '_blank');
                    } catch (e) {
                        alert('Unable to open new tab. URL: ' + url);
                    }
                });
                li.appendChild(openBtn);
                // Shelly Status button: opens the device's local status page in a new tab
                const statusBtn = document.createElement('button');
                statusBtn.textContent = 'Shelly Status';
                statusBtn.style.marginLeft = '6px';
                statusBtn.addEventListener('click', () => {
                    const targetIp = info && typeof info === 'object' ? (info.ip || '<device-ip>') : '<device-ip>';
                    const url = `http://${targetIp}/script/1/status`;
                    try {
                        window.open(url, '_blank');
                    } catch (e) {
                        alert('Unable to open new tab. URL: ' + url);
                    }
                });
                li.appendChild(statusBtn);
                ul.appendChild(li);
            }
        listRoot.appendChild(ul);
    } catch (err) {
        listRoot.textContent = `Failed to load devices: ${err.message}`;
    }
}

    /*
     * isValidHost(host)
     * -----------------
     * Mirror of the server-side validation used when adding or updating
     * Shelly device hostnames/IPs in the settings UI.
     */
    function isValidHost(host) {
      if (!host || typeof host !== 'string') return false;
      const ipv4 = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;
      const hostname = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*$/;
      return ipv4.test(host) || hostname.test(host);
    }

/*
 * Settings form submit handler
 * ----------------------------
 * Persist updated global settings (watchdog and price fetch intervals)
 * back to the server when the settings form is submitted.
 */
document.getElementById('settingsForm').addEventListener('submit', async (e) => {
e.preventDefault();
const payload = {
    watchdogInterval: parseInt(document.getElementById('watchdogInterval').value),
    priceFetchInterval: parseInt(document.getElementById('priceFetchInterval').value)
};
    // include global motion recording enabled flag
    payload.motionRecordingEnabled = !!document.getElementById('motionRecordingEnabled').checked;
    // include global audio recording enabled flag
    payload.audioRecordingEnabled = !!document.getElementById('audioRecordingEnabled').checked;
const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
});
alert(await res.text());
});

/*
 * Add Shelly form submit handler
 * ------------------------------
 * Handle the UI flow for adding a new Shelly device. Performs client-side
 * validation before posting to /api/shelly and reloads the device list on
 * success.
 */
document.getElementById('addShellyForm').addEventListener('submit', async (e) => {
e.preventDefault();
const payload = {
    name: document.getElementById('shellyName').value,
    description: document.getElementById('shellyDescription').value,
    ip: document.getElementById('shellyIP').value
};
// Client-side validation
if (!isValidHost(payload.ip)) { alert('Invalid IP/hostname'); return; }

const res = await fetch('/api/shelly', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
});
    const text = await res.text();
    alert(text);
    if (res.ok) {
        // Refresh device list and main UI (reload to ensure frontend modules initialize it)
        await loadDevicesList();
        window.location.reload();
    }
});

/*
 * loadCameraSettings()
 * --------------------
 * Fetch camera settings from /api/settings and populate the camera settings UI.
 */
async function loadCameraSettings() {
    try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        const globalSensitivity = data.motionSensitivityDefault || 15;
        document.getElementById('globalMotionSensitivity').value = globalSensitivity;

        const globalObjectTypes = (data.objectTypesDefault || ['person', 'vehicle']).join(',');
        document.getElementById('globalObjectTypes').value = globalObjectTypes;

        const cameras = data.videoCameras || {};
        const root = document.getElementById('cameraSettingsRoot');
        root.innerHTML = '';

        if (Object.keys(cameras).length === 0) {
            root.textContent = 'No cameras configured.';
            return;
        }

        for (const [id, cam] of Object.entries(cameras)) {
            const div = document.createElement('div');
            div.style.marginBottom = '10px';
            div.innerHTML = `
                <label>Camera ${id} (${cam.name || 'Unnamed'}): Motion Sensitivity
                    <input type="number" class="camera-sensitivity" data-camera-id="${id}" min="0" max="100" step="0.01" value="${cam.motionSensitivity || globalSensitivity}" placeholder="e.g. 15 or 0.15">
                </label>
                <br>
                <label>Camera ${id} Object Types (comma-separated):
                    <input type="text" class="camera-object-types" data-camera-id="${id}" value="${(cam.objectTypes || []).join(',')}" placeholder="e.g. person,vehicle">
                </label>
            `;
            root.appendChild(div);
        }
    } catch (e) {
        console.warn('Failed to load camera settings:', e.message);
        document.getElementById('cameraSettingsRoot').textContent = 'Failed to load camera settings.';
    }
}

/*
 * saveCameraSettings()
 * --------------------
 * Collect camera settings from UI and save to server via /api/camera-settings.
 */
async function saveCameraSettings() {
    try {
        const globalSensitivity = parseFloat(document.getElementById('globalMotionSensitivity').value) || 15;
        const globalObjectTypesStr = document.getElementById('globalObjectTypes').value.trim();
        const globalObjectTypes = globalObjectTypesStr ? globalObjectTypesStr.split(',').map(s => s.trim()).filter(s => s) : ['person', 'vehicle'];

        const cameraInputs = document.querySelectorAll('.camera-sensitivity');
        const cameraObjectInputs = document.querySelectorAll('.camera-object-types');
        const cameraSettings = {};

        // Collect sensitivity settings
        cameraInputs.forEach(input => {
            const id = input.dataset.cameraId;
            const sensitivity = parseFloat(input.value);
            if (!isNaN(sensitivity)) {
                if (!cameraSettings[id]) cameraSettings[id] = {};
                cameraSettings[id].motionSensitivity = sensitivity;
            }
        });

        // Collect object type settings
        cameraObjectInputs.forEach(input => {
            const id = input.dataset.cameraId;
            const objectTypesStr = input.value.trim();
            const objectTypes = objectTypesStr ? objectTypesStr.split(',').map(s => s.trim()).filter(s => s) : [];
            if (objectTypes.length > 0) {
                if (!cameraSettings[id]) cameraSettings[id] = {};
                cameraSettings[id].objectTypes = objectTypes;
            }
        });

        const payload = {
            motionSensitivityDefault: globalSensitivity,
            objectTypesDefault: globalObjectTypes,
            cameraSettings
        };

        const res = await fetch('/api/camera-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            alert('Camera settings saved successfully.');
        } else {
            alert('Failed to save camera settings.');
        }
    } catch (e) {
        console.error('Error saving camera settings:', e);
        alert('Error saving camera settings.');
    }
}

/* Initialize settings page on DOMContentLoaded */
document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    await loadDevicesList();
    await loadMotionRecordingFlag();
    await loadAudioRecordingFlag();
    await loadCameraSettings();
    await loadUserPreferences();

    // Bind save camera settings button
    document.getElementById('saveCameraSettings').addEventListener('click', saveCameraSettings);
    
    // Bind user preferences change events
    document.getElementById('timezoneSelect').addEventListener('change', saveUserPreferences);
    document.getElementById('localeSelect').addEventListener('change', saveUserPreferences);
    document.getElementById('timeFormatSelect').addEventListener('change', saveUserPreferences);
});

/* Modal helper to display upload progress/result and optional script for manual upload */
function showUploadModal(message, script) {
    let modal = document.getElementById('uploadModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'uploadModal';
        modal.style.position = 'fixed';
        modal.style.left = '50%';
        modal.style.top = '50%';
        modal.style.transform = 'translate(-50%, -50%)';
        modal.style.background = '#fff';
        modal.style.border = '1px solid #444';
        modal.style.padding = '16px';
        modal.style.zIndex = 10000;
        modal.style.maxWidth = '90%';
        modal.style.maxHeight = '80%';
        modal.style.overflow = 'auto';
        document.body.appendChild(modal);
    }
    modal.innerHTML = '';
    const title = document.createElement('h3');
    title.textContent = 'Shelly Script Upload';
    modal.appendChild(title);
    const pre = document.createElement('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.maxHeight = '200px';
    pre.style.overflow = 'auto';
    pre.textContent = message || '';
    modal.appendChild(pre);

    if (script) {
    // Note removed: we no longer attempt automatic upload. The script is
    // shown below for manual copy/paste or download by the operator.
        const ta = document.createElement('textarea');
        ta.style.width = '100%';
        ta.style.height = '300px';
        ta.value = script;
        modal.appendChild(ta);
        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copy to clipboard';
        copyBtn.addEventListener('click', () => {
            ta.select();
            document.execCommand('copy');
            alert('Script copied to clipboard');
        });
        modal.appendChild(copyBtn);
        const dlBtn = document.createElement('button');
        dlBtn.textContent = 'Download .js';
        dlBtn.style.marginLeft = '8px';
        dlBtn.addEventListener('click', () => {
            const blob = new Blob([script], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'shellyScript.js';
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
        });
        modal.appendChild(dlBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.display = 'block';
    closeBtn.style.marginTop = '12px';
    closeBtn.addEventListener('click', () => { modal.remove(); });
    modal.appendChild(closeBtn);
}
