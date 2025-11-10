/*
 * Price Analysis Utilities
 * ------------------------
 * Helper functions for analyzing energy prices and determining
 * device control decisions based on price thresholds and cheapest slots.
 */

/*
 * calculatePeriodAverage(prices, startIdx, endIdx)
 * -------------------------------------------------
 * Calculate the average price for a given period of slots.
 * Filters out zero/invalid prices and returns Infinity if no valid prices.
 */
function calculatePeriodAverage(prices, startIdx, endIdx) {
  const periodPrices = prices.slice(startIdx, endIdx).filter(p => p > 0);
  return periodPrices.length > 0 ? periodPrices.reduce((sum, p) => sum + p, 0) / periodPrices.length : Infinity;
}

/*
 * findCheapestSlots(prices, slotsPerPeriod, slotsPerDay, numCheapest, maxPrice)
 * -----------------------------------------------------------------------------
 * Find the cheapest slots within a day based on average prices per period.
 * Returns an array of slot indices that should be ON.
 */
function findCheapestSlots(prices, slotsPerPeriod, slotsPerDay, numCheapest, maxPrice = Infinity) {
  const slotPrices = [];
  for (let i = 0; i < slotsPerDay; i++) {
    const startIdx = i * slotsPerPeriod;
    const endIdx = Math.min(startIdx + slotsPerPeriod, prices.length);
    const avgPrice = calculatePeriodAverage(prices, startIdx, endIdx);
    slotPrices.push({ price: avgPrice, index: i });
  }

  return slotPrices
    .filter(s => s.price < Infinity && s.price <= maxPrice)
    .sort((a, b) => a.price - b.price)
    .slice(0, numCheapest)
    .map(s => s.index);
}

/*
 * shouldDeviceBeOn(currentPrice, settings, pricesInfo)
 * ---------------------------------------------------
 * Determine if a device should be ON based on current price and settings.
 * Handles manual overrides, fallback hours, min/max thresholds, and cheapest slots.
 */
function shouldDeviceBeOn(currentPrice, settings, pricesInfo) {
  const { combinedData, currentSlotIndex } = pricesInfo;

  // Handle manual override
  if (settings.manualOverride) {
    if (settings.manualState === 'on') {
      return true;
    } else if (settings.manualState === 'off') {
      return false;
    } else {
      // manualOverride enabled but no explicit manualState
      return null; // Skip automated control
    }
  }

  // Check if we have valid price data
  if (!combinedData.some(p => p > 0)) {
    // Use fallback hours
    const now = new Date();
    const currentHour = now.getHours();
    return settings.fallbackHours[currentHour];
  }

  const timeFrame = settings.timeFrame || '15min';
  const slotsPerPeriod = timeFrame === '1hour' ? 4 : timeFrame === '30min' ? 2 : 1;
  const currentPeriodIndex = Math.floor(currentSlotIndex / slotsPerPeriod);

  const minPrice = parseFloat(settings.minPrice) || 0;
  const maxPrice = parseFloat(settings.maxPrice) || Infinity;
  const numCheapest = parseInt(settings.numCheapest) || 0;

  // Calculate current period average price
  const startIdx = currentPeriodIndex * slotsPerPeriod;
  const endIdx = Math.min(startIdx + slotsPerPeriod, combinedData.length);
  const avgPrice = calculatePeriodAverage(combinedData, startIdx, endIdx);

  // Apply price-based rules
  if (avgPrice < minPrice) {
    return true; // Below min price - turn ON
  } else if (avgPrice > maxPrice) {
    return false; // Above max price - turn OFF
  } else if (numCheapest > 0) {
    // Check if current period is among the cheapest
    const slotsPerDay = timeFrame === '1hour' ? 24 : timeFrame === '30min' ? 48 : 96;
    const cheapestSlots = findCheapestSlots(combinedData, slotsPerPeriod, slotsPerDay, numCheapest, maxPrice);
    return cheapestSlots.includes(currentPeriodIndex);
  }

  return false; // Default to OFF
}

module.exports = {
  calculatePeriodAverage,
  findCheapestSlots,
  shouldDeviceBeOn
};