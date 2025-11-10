/*
 * Settings Management Module
 * --------------------------
 * Handles loading, saving, and syncing device settings between
 * the server, localStorage, and Shelly devices.
 */

/*
 * loadSettingsFromServer(id)
 * --------------------------
 * Fetch per-device settings from the server (`/api/load-settings?id=<id>`).
 * Returns parsed settings or a sensible default object if the request fails.
 * The frontend stores a local copy in localStorage and merges with values
 * returned by this helper.
 */
async function loadSettingsFromServer(id) {
  try {
    const response = await fetch(`/api/load-settings?id=${id}`);
    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error(`Failed to load settings for Shelly ${id}:`, error.message);
    return {
      minPrice: 0.05,
      maxPrice: 0.20,
      numCheapest: 4,
      timeFrame: '15min',
      manualOverride: false,
      fallbackHours: Array(24).fill(false)
    }; // Fallback to defaults
  }
}

/*
 * saveSettingsToServer(id, settings)
 * ---------------------------------
 * Persist settings to the server using /api/save-settings. Errors are
 * logged but not surfaced; the function is a convenience wrapper used by
 * form handlers.
 */
async function saveSettingsToServer(id, settings) {
  try {
    await fetch('/api/save-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, settings })
    });
  } catch (error) {
    console.error(`Failed to save settings for Shelly ${id} to server:`, error.message);
  }
}

/*
 * syncRulesToShelly(id, rules)
 * ----------------------------
 * POST the provided `rules` (settings) to /api/sync-rules for the device.
 * This is used at initialization and after settings changes to ensure the
 * Shelly device receives updated configuration.
 */
async function syncRulesToShelly(id, rules) {
  try {
    const response = await fetch('/api/sync-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, rules })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Rule sync failed');
    console.log(`Rules synced to Shelly ${id}:`, rules);
  } catch (error) {
    console.error(`Failed to sync rules to Shelly ${id}:`, error.message);
  }
}

// Export functions for use in other modules
window.SettingsModule = {
  loadSettingsFromServer,
  saveSettingsToServer,
  syncRulesToShelly
};