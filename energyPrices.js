const fs = require('fs');
const { createChildLogger } = require('./utils/logger');

const logger = createChildLogger('energyPrices');

/*
 * sleep(ms)
 * ---------
 * Utility function for delays in retry logic.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/*
 * retryWithBackoff(fn, maxRetries, baseDelay)
 * -------------------------------------------
 * Retry a function with exponential backoff.
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) {
        logger.error('Max retries exceeded', {
          error: error.message,
          attempts: maxRetries + 1
        });
        break;
      }

      const delay = baseDelay * Math.pow(2, attempt);
      logger.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms`, {
        error: error.message,
        nextAttemptIn: delay
      });

      await sleep(delay);
    }
  }

  throw lastError;
}

/*
 * validateApiResponse(data)
 * -------------------------
 * Validate the structure of API response data.
 */
function validateApiResponse(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid API response: not an object');
  }

  if (!data.data || typeof data.data !== 'object') {
    throw new Error('Invalid API response: missing data object');
  }

  if (!data.data.fi || !Array.isArray(data.data.fi)) {
    throw new Error('Invalid API response: missing or invalid fi array');
  }

  // Validate each data point
  data.data.fi.forEach((point, index) => {
    if (!point.timestamp || typeof point.timestamp !== 'number') {
      throw new Error(`Invalid data point at index ${index}: missing or invalid timestamp`);
    }
    if (typeof point.price !== 'number' || point.price < 0) {
      throw new Error(`Invalid data point at index ${index}: missing or invalid price`);
    }
  });

  return true;
}
async function fetchEnergyPrices() {
  try {
    logger.info('Starting energy prices fetch operation');

    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const formatDate = (date) => date.toISOString().split('T')[0]; // YYYY-MM-DD

    const todayStr = formatDate(today);
    const tomorrowStr = formatDate(tomorrow);

    const startToday = `${todayStr}T00:00:00.000Z`;
    const endToday = `${todayStr}T23:59:59.999Z`;
    const startTomorrow = `${tomorrowStr}T00:00:00.000Z`;
    const endTomorrow = `${tomorrowStr}T23:59:59.999Z`;

  /*
   * fetchPricesForPeriod(start, end)
   * --------------------------------
   * Helper that calls the Elering API for the provided start/end ISO range
   * and returns the raw data array (or an empty array on failure). This is
   * kept internal to `fetchEnergyPrices`.
   */
  const fetchPricesForPeriod = async (start, end) => {
    try {
      const result = await retryWithBackoff(async () => {
        logger.debug('Fetching prices from API', { start, end });

        const response = await fetch(
          `https://dashboard.elering.ee/api/nps/price?start=${start}&end=${end}`,
          {
            timeout: 10000, // 10 second timeout
            headers: {
              'User-Agent': 'Home-Control-Center/1.0'
            }
          }
        );

        if (!response.ok) {
          throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        // Validate response structure
        validateApiResponse(data);

        return data;
      });

      const entries = result.data.fi?.length || 0;
      logger.info('Successfully fetched price data', {
        start,
        end,
        entries,
        sampleData: result.data.fi?.slice(0, 2)
      });

      return result.data.fi || [];
    } catch (error) {
      logger.error('Failed to fetch price data after retries', {
        start,
        end,
        error: error.message
      });
      return [];
    }
  };

  /*
   * processPrices15Min(rawData, dateStr)
   * ------------------------------------
   * Convert raw API data points into a fixed-length 96-slot array for the
   * given date. If data is missing, slots are zero-filled. Prices are
   * converted using the project's multiplier and tax calculation
   * (point.price / 10 * 1.255).
   */
  const processPrices15Min = (rawData, dateStr) => {
    // Initialize 96 slots with zero prices
    const slots = Array.from({ length: 96 }, (_, i) => {
      const hour = Math.floor(i / 4);
      const minute = (i % 4) * 15;
      const time = `${dateStr}T${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:00.000Z`;
      return { time, price: 0 };
    });

    // If no data, return zero-filled slots
    if (!rawData || !Array.isArray(rawData) || rawData.length === 0) {
      logger.warn(`No data available for ${dateStr}, returning 96 zero-filled slots`);
      return slots;
    }

    // Map API data to slots
    rawData.forEach((point) => {
      const timestamp = new Date(point.timestamp * 1000);
      const hour = timestamp.getUTCHours();
      const minute = timestamp.getUTCMinutes();
      const slotIndex = hour * 4 + Math.floor(minute / 15); // Calculate slot index (0-95)
      
      if (slotIndex >= 0 && slotIndex < 96) {
        slots[slotIndex].price = point.price / 10 * 1.255; // Convert to c/kWh and add tax
      }
    });

    const nonZeroSlots = slots.filter(s => s.price !== 0).length;
    logger.info(`Processed price data for ${dateStr}`, {
      totalSlots: 96,
      nonZeroSlots,
      zeroSlots: 96 - nonZeroSlots
    });

    return slots;
  };

  const todayRaw = await fetchPricesForPeriod(startToday, endToday);
  const tomorrowRaw = await fetchPricesForPeriod(startTomorrow, endTomorrow);

  const todayPrices = processPrices15Min(todayRaw, todayStr);
  const tomorrowPrices = processPrices15Min(tomorrowRaw, tomorrowStr);

  fs.writeFileSync('./prices.json', JSON.stringify({ today: todayPrices, tomorrow: tomorrowPrices }, null, 2));
  logger.info('Energy prices successfully updated and saved', {
    todayDate: todayStr,
    tomorrowDate: tomorrowStr,
    todaySlots: todayPrices.length,
    tomorrowSlots: tomorrowPrices.length,
    filePath: './prices.json'
  });
  } catch (error) {
    logger.error('Energy prices fetch operation failed', {
      error: error.message,
      stack: error.stack
    });
    throw error; // Re-throw to allow caller to handle
  }
}

module.exports = { fetchEnergyPrices };

// Run the function if this script is executed directly
if (require.main === module) {
  fetchEnergyPrices()
    .then(() => {
      logger.info('Energy prices fetch completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Energy prices fetch failed', { error: error.message });
      process.exit(1);
    });
}