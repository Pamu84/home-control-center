const axios = require('axios');
const { getServerConfig } = require('./config/manager');
const { sendTelegramMessage } = require('./notificationManager');
const { shouldDeviceBeOn } = require('./utils/priceAnalysis');

const { SERVER_IP, SERVER_PORT } = getServerConfig();

/*
 * applyShellyControl(pricesInfo, settings)
 * ---------------------------------------
 * Evaluate the current energy prices and device settings and decide whether
 * the Shelly device should be ON or OFF. This function computes the
 * appropriate boolean `shouldBeOn` by considering manual overrides,
 * fallbackHours, min/max price thresholds and the `numCheapest` selection.
 * Finally it posts a control action to the server's /api/control endpoint.
 * - pricesInfo: { combinedData: Array<number>, currentSlotIndex: number }
 * - settings: per-device settings object (includes id, minPrice, maxPrice,
 *   numCheapest, timeFrame, manualOverride, manualState, fallbackHours)
 */
async function applyShellyControl(pricesInfo, settings) {
  const { combinedData, currentSlotIndex } = pricesInfo;
  if (currentSlotIndex === -1) {
    console.log('No current slot, skipping control');
    return;
  }

  const currentPrice = combinedData[currentSlotIndex] || 0;
  if (currentPrice === 0 && !settings.manualOverride && combinedData.some(p => p > 0)) {
    console.log('Current price is 0, skipping control (invalid data)');
    return;
  }

  // Use the extracted price analysis logic
  const shouldBeOn = shouldDeviceBeOn(currentPrice, settings, pricesInfo);

  // Skip control if manual override is active but no explicit state
  if (shouldBeOn === null) {
    console.log(`Shelly ${settings.id}: manualOverride active without explicit manualState - skipping automated control`);
    return;
  }

  const action = shouldBeOn ? 'on' : 'off';
  try {
    // Use POST /api/control with JSON body (server expects POST)
    await axios.post(`http://${SERVER_IP}:${SERVER_PORT}/api/control`, { id: settings.id, action }, { timeout: 5000 });
    console.log(`Applied rule: Shelly ${settings.id} ${action} (price: ${currentPrice})`);
  } catch (error) {
    console.error('Control failed:', error.message);
  }
}

/*
 * monitorPriceFeed(priceDataTimestamp)
 * -----------------------------------
 * Lightweight monitor that sends an alert if the price data timestamp is
 * older than a threshold (1 hour). This helps catch failures in the price
 * ingestion pipeline.
 */
async function monitorPriceFeed(priceDataTimestamp) {
  const now = Date.now();
  if ((now - priceDataTimestamp) > 60 * 60 * 1000) { // 1 hour old
    await sendTelegramMessage(`⚠️ Electricity price data has not been updated for over an hour.`);
  }
}

module.exports = { applyShellyControl };