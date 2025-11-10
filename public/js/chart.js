/*
 * Chart and Data Visualization Module
 * -----------------------------------
 * Handles price data fetching, chart rendering, and state calculations
 * for the main price chart and per-device state charts.
 */

// Global chart instances (persisted across renders)
let priceChart = null;
let stateCharts = {};

// Current timeFrame of the price chart (to detect changes)
let currentPriceChartTimeFrame = null;

// UI timezone used by all front-end time formatting. Persisted in localStorage.
var UI_TIMEZONE = localStorage.getItem('uiTimeZone') || 'Europe/Helsinki';
// User locale and time format preferences
var UI_LOCALE = 'fi-FI'; // default fallback
var UI_TIME_FORMAT = '24h'; // '12h' or '24h'

/*
 * fetchUserPreferences()
 * ----------------------
 * Fetch user preferences from the server and update global variables.
 */
async function fetchUserPreferences() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
    const settings = await res.json();
    if (settings.userPreferences) {
      UI_LOCALE = settings.userPreferences.locale || 'fi-FI';
      UI_TIME_FORMAT = settings.userPreferences.timeFormat || '24h';
      // Update timezone if different from localStorage
      if (settings.userPreferences.timezone !== UI_TIMEZONE) {
        UI_TIMEZONE = settings.userPreferences.timezone;
        localStorage.setItem('uiTimeZone', UI_TIMEZONE);
      }
    }
  } catch (error) {
    console.warn('Failed to fetch user preferences:', error);
    // Keep defaults
  }
}

/*
 * fetchPrices()
 * -------------
 * Fetch the cached prices payload from the server (`/api/prices`). Returns
 * an object { today: [...], tomorrow: [...] } or { today: [], tomorrow: [] }
 * on error. The charting and scheduling logic consumes this shape.
 * Also fetches user preferences to update locale and time format settings.
 */
async function fetchPrices() {
  // Fetch user preferences first
  await fetchUserPreferences();
  
  try {
    const res = await fetch('/api/prices');
    if (!res.ok) throw new Error(`HTTP error: ${res.status}`);
    return await res.json();
  } catch (error) {
    console.error('Fetch prices failed:', error);
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = 'Failed to load prices. Please try again later.';
    document.body.prepend(errorDiv);
    return { today: [], tomorrow: [] };
  }
}

/*
 * isPricesAvailable(pricesInfo)
 * -----------------------------
 * Lightweight check that returns true when combined price data contains at
 * least one non-null value. Used to decide whether to compute schedules or
 * fallback to hourly `fallbackHours` settings.
 */
function isPricesAvailable(pricesInfo) {
  const { combinedData } = pricesInfo;
  return combinedData.length > 0 && combinedData.some(p => p !== null && p !== undefined);
}

/*
 * getRawPricesInfo(prices)
 * ------------------------
 * Create flattened arrays of labels and numeric price values for today and
 * tomorrow and compute the current 15-minute slot index (UTC-based). The
 * returned object is used by charting and scheduling functions.
 */
function getRawPricesInfo(prices) {
  const combinedLabels = [
    ...prices.today.map(p => p.time),
    ...prices.tomorrow.map(p => p.time)
  ];
  const combinedData = [
    ...prices.today.map(p => p.price),
    ...prices.tomorrow.map(p => p.price)
  ];

  const now = new Date();
  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();
  const todayStr = now.toISOString().split('T')[0];
  const slotTime = `${todayStr}T${String(utcHours).padStart(2, '0')}:${String(Math.floor(utcMinutes / 15) * 15).padStart(2, '0')}:00.000Z`;
  const currentSlotIndex = combinedLabels.indexOf(slotTime);
  console.log(`Server time slot: ${slotTime}, index: ${currentSlotIndex}`);
  if (currentSlotIndex === -1) {
    console.warn(`Current slot time ${slotTime} not found in price data`);
  }
  return { combinedData, combinedLabels, currentSlotIndex };
}

/*
 * renderChart(prices, timeFrame)
 * -----------------------------
 * Render or update the main price bar chart using Chart.js. Supports
 * aggregation to hourly averages when `timeFrame` is '1hour'. Highlights
 * the current slot visually.
 */
function renderChart(prices, timeFrame = '15min') {
  const canvas = document.getElementById('priceChart');
  if (!canvas) {
    console.error('Price chart canvas not found in DOM');
    return; // Exit if canvas is missing
  }

  let combinedLabels = [
    ...prices.today.map(p => p.time),
    ...prices.tomorrow.map(p => p.time)
  ];
  let combinedData = [
    ...prices.today.map(p => p.price),
    ...prices.tomorrow.map(p => p.price)
  ];

  const now = new Date();
  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();
  const todayStr = now.toISOString().split('T')[0];
  const slotTime = `${todayStr}T${String(utcHours).padStart(2, '0')}:${String(Math.floor(utcMinutes / 15) * 15).padStart(2, '0')}:00.000Z`;
  let currentSlotIndex = combinedLabels.indexOf(slotTime);

  // Calculate local date for display labels (used in 1-hour aggregation)
  const localTodayStr = new Date(now.toLocaleString('en-US', { timeZone: UI_TIMEZONE })).toISOString().split('T')[0];
  const localTomorrowStr = new Date(new Date(now.getTime() + 24 * 60 * 60 * 1000).toLocaleString('en-US', { timeZone: UI_TIMEZONE })).toISOString().split('T')[0];

  // Process data based on timeFrame
  let displayLabels = [];
  let displayData = [];
  let slotsPerPeriod = 1;
  let titleText = 'Energy Day-Ahead Prices (Finland, 15-min)';
  let tickStep = 4;

  if (timeFrame === '1hour') {
    // Aggregate to hourly averages
    const slotsPerDay = 96; // 15-min slots per day
    const periodsPerDay = 24; // Hourly periods per day
    const slotsPerHour = 4; // 15-min slots per hour
    const hasTomorrow = prices.tomorrow.length > 0 && prices.tomorrow.some(p => p.price > 0);
    const totalPeriods = hasTomorrow ? periodsPerDay * 2 : periodsPerDay;

    displayLabels = Array.from({ length: totalPeriods }, (_, i) => {
      const dayIndex = Math.floor(i / periodsPerDay);
      const hour = i % periodsPerDay;
      let dateStr;
      if (dayIndex === 0) {
        dateStr = localTodayStr;
      } else {
        // For tomorrow, try to get the local date from tomorrow's price data
        if (prices.tomorrow.length > 0) {
          const tomorrowUtc = new Date(prices.tomorrow[0].time);
          dateStr = new Date(tomorrowUtc.toLocaleString('en-US', { timeZone: UI_TIMEZONE })).toISOString().split('T')[0];
        } else {
          dateStr = localTomorrowStr;
        }
      }
      return `${dateStr}T${hour.toString().padStart(2, '0')}:00:00.000Z`;
    });

    displayData = Array(totalPeriods).fill(0);
    for (let i = 0; i < totalPeriods; i++) {
      const startIdx = i * slotsPerHour;
      const endIdx = Math.min(startIdx + slotsPerHour, combinedData.length);
      const periodPrices = combinedData.slice(startIdx, endIdx).filter(p => p !== null && p !== undefined);
      displayData[i] = periodPrices.length > 0
        ? periodPrices.reduce((sum, p) => sum + p, 0) / periodPrices.length
        : 0;
    }

    currentSlotIndex = currentSlotIndex >= 0 ? Math.floor(currentSlotIndex / slotsPerHour) : -1;
    titleText = 'Energy Day-Ahead Prices (Finland, Hourly Average)';
    tickStep = 1;
  } else {
    displayLabels = combinedLabels;
    displayData = combinedData;
  }

  // Format labels as HH:MM in user timezone
  const formattedLabels = displayLabels.map(time =>
    new Date(time).toLocaleString(UI_LOCALE, {
      timeZone: UI_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: UI_TIME_FORMAT === '12h'
    })
  );

  console.log('Current slot index:', currentSlotIndex, 'Time:', slotTime, 'Price:', displayData[currentSlotIndex] || 0);

  const rootStyles = getComputedStyle(document.documentElement);
  const primaryColor = rootStyles.getPropertyValue('--primary-color').trim() || '#00ff00';
  const primaryBorderColor = rootStyles.getPropertyValue('--primary-border-color').trim() || '#00cc00';
  const currentColor = rootStyles.getPropertyValue('--current-color').trim() || '#ff0000';
  const currentBorderColor = rootStyles.getPropertyValue('--current-border-color').trim() || '#cc0000';

  const backgroundColors = displayData.map((_, i) => (i === currentSlotIndex ? currentColor : primaryColor));
  const borderColors = displayData.map((_, i) => (i === currentSlotIndex ? currentBorderColor : primaryBorderColor));

  // Calculate max price for y-axis scaling (always at least 20)
  const maxPrice = Math.max(...displayData.filter(p => p > 0));
  const yAxisMax = Math.max(20, maxPrice);

  // Check if timeFrame changed - if so, destroy and recreate chart for fresh tooltips
  const timeFrameChanged = currentPriceChartTimeFrame !== timeFrame;
  currentPriceChartTimeFrame = timeFrame;

  if (priceChart && Chart.getChart(canvas) && !timeFrameChanged) {
    // TimeFrame didn't change - update chart in place for smooth refreshes
    priceChart.data.labels = formattedLabels;
    priceChart.data.datasets[0].data = displayData;
    priceChart.data.datasets[0].backgroundColor = backgroundColors;
    priceChart.data.datasets[0].borderColor = borderColors;
    priceChart.options.plugins.title.text = titleText;
    priceChart.options.scales.y.max = yAxisMax;
    priceChart.update();
  } else {
    // TimeFrame changed or no chart exists - destroy and recreate for fresh tooltips
    if (priceChart && Chart.getChart(canvas)) {
      priceChart.destroy();
    }
    
    priceChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: formattedLabels,
      datasets: [{
        label: 'Electricity Price (c/kWh)',
        data: displayData,
        backgroundColor: backgroundColors,
        borderColor: borderColors,
        borderWidth: 1
      }]
    },
    options: {
      scales: {
        y: {
          min: 0,
          max: yAxisMax,
          title: { display: true, text: 'Price (c/kWh)' }
        },
        x: {
          title: { display: true, text: 'Time' },
          ticks: {
            maxRotation: 45,
            minRotation: 45,
            callback: function(value, index) {
              return index % tickStep === 0 ? this.getLabelForValue(value) : '';
            }
          }
        }
      },
      plugins: {
        title: { display: true, text: titleText },
        tooltip: {
          callbacks: {
            title: function(context) {
              const dataIndex = context[0].dataIndex;
              const utcTime = displayLabels[dataIndex];
              const startTime = new Date(utcTime);
              const endTime = new Date(startTime.getTime() + (timeFrame === '1hour' ? 60 * 60 * 1000 : 15 * 60 * 1000));
              
              const startFormatted = startTime.toLocaleString(UI_LOCALE, {
                timeZone: UI_TIMEZONE,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: UI_TIME_FORMAT === '12h'
              });
              
              if (timeFrame === '1hour') {
                const endFormatted = endTime.toLocaleString(UI_LOCALE, {
                  timeZone: UI_TIMEZONE,
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: UI_TIME_FORMAT === '12h'
                });
                return `${startFormatted} - ${endFormatted}` + (dataIndex === currentSlotIndex ? ' (Current)' : '');
              } else {
                return startFormatted + (dataIndex === currentSlotIndex ? ' (Current)' : '');
              }
            }
          }
        }
      }
    }
  });
  }
}

/*
 * calculateShellyStates(pricesInfo, settings, manualOverride)
 * ---------------------------------------------------------
 * Compute the ON/OFF boolean states for each slot given raw price data and
 * device settings. Handles manual overrides, fallback hours, cheapest-slot
 * selection, and min/max price thresholds. Returns { states, labels, rawLabels }.
 */
function calculateShellyStates(pricesInfo, settings, manualOverride) {
  const { combinedData, combinedLabels } = pricesInfo;
  const tomorrowData = combinedData.slice(96); // Tomorrow's slots (96-191)
  const tomorrowHasData = tomorrowData.length > 0 && tomorrowData.some(price => price > 0);

  // Determine slot configuration based on timeFrame
  const timeFrame = settings.timeFrame || '15min';
  let slotsPerDay, slotsPerPeriod, labelsPerDay;
  switch (timeFrame) {
    case '15min':
      slotsPerDay = 96;
      slotsPerPeriod = 1;
      labelsPerDay = combinedLabels.slice(0, 96).filter((_, i) => i % 1 === 0);
      break;
    case '30min':
      slotsPerDay = 48;
      slotsPerPeriod = 2;
      labelsPerDay = combinedLabels.slice(0, 96).filter((_, i) => i % 2 === 0);
      break;
    case '1hour':
      slotsPerDay = 24;
      slotsPerPeriod = 4;
      labelsPerDay = combinedLabels.slice(0, 96).filter((_, i) => i % 4 === 0);
      break;
    default:
      slotsPerDay = 96;
      slotsPerPeriod = 1;
      labelsPerDay = combinedLabels.slice(0, 96);
  }

  const totalSlots = tomorrowHasData ? slotsPerDay * 2 : slotsPerDay;
  const totalLabels = tomorrowHasData ? [...labelsPerDay, ...combinedLabels.slice(96).filter((_, i) => i % slotsPerPeriod === 0)] : labelsPerDay;

  // Format labels as HH:MM in user timezone
  const formattedLabels = totalLabels.map(time =>
    new Date(time).toLocaleString(UI_LOCALE, {
      timeZone: UI_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: UI_TIME_FORMAT === '12h'
    })
  );

  const states = Array(totalSlots).fill(0); // Default to OFF

  // If manual override is enabled, consider manualState (on/off/null)
  if (settings && settings.manualOverride) {
    if (settings.manualState === 'on') {
      states.fill(1);
      return { states, labels: formattedLabels };
    } else if (settings.manualState === 'off') {
      states.fill(0);
      return { states, labels: formattedLabels };
    }
    // manualOverride true but manualState not specified: fall through and render computed schedule
  } else if (manualOverride) {
    // Backwards compatibility: if caller passed manualOverride true but settings not present
    states.fill(1);
    return { states, labels: formattedLabels };
  }

  if (!isPricesAvailable(pricesInfo)) {
    // Use fallback hourly settings
    const periodsPerHour = timeFrame === '15min' ? 4 : timeFrame === '30min' ? 2 : 1;
    for (let i = 0; i < totalSlots; i++) {
      const periodInDay = i % slotsPerDay;
      const hour = Math.floor(periodInDay / periodsPerHour) % 24;
      states[i] = settings.fallbackHours[hour] ? 1 : 0;
    }
    return { states, labels: formattedLabels };
  }

  // Calculate average prices for each slot
  const slotPrices = [];
  for (let i = 0; i < totalSlots; i++) {
    const startIdx = i * slotsPerPeriod;
    const endIdx = Math.min(startIdx + slotsPerPeriod, combinedData.length);
    const periodPrices = combinedData.slice(startIdx, endIdx).filter(p => p > 0);
    const avgPrice = periodPrices.length > 0 ? periodPrices.reduce((sum, p) => sum + p, 0) / periodPrices.length : Infinity;
    slotPrices.push({ price: avgPrice, index: i });
  }

  const minPrice = parseFloat(settings.minPrice) || 0;
  const maxPrice = parseFloat(settings.maxPrice) || Infinity;
  // `numCheapest` is interpreted as number of periods per DAY. When tomorrow's
  // prices are available, the effective number of cheapest periods to select
  // should scale accordingly (e.g., 24 hours => 48 periods if tomorrow present).
  const perDayCheapest = parseInt(settings.numCheapest) || 0;
  const effectiveNumCheapest = Math.min(perDayCheapest * (tomorrowHasData ? 2 : 1), totalSlots);

  // Apply min/max price rules
  slotPrices.forEach(({ price, index }) => {
    if (price < minPrice) {
      states[index] = 1; // ON if below min price
    } else if (price > maxPrice) {
      states[index] = 0; // OFF if above max price
    }
  });

  // Apply cheapest slots rule per-day: select `perDayCheapest` cheapest
  // periods for today and (if present) for tomorrow independently.
  if (perDayCheapest > 0) {
    var perDayLimit = Math.min(perDayCheapest, slotsPerDay);
    for (var day = 0; day < (tomorrowHasData ? 2 : 1); day++) {
      var dayStart = day * slotsPerDay;
      var dayEnd = dayStart + slotsPerDay - 1;
      // Collect candidate slots within this day that pass maxPrice filter
      var dayCandidates = slotPrices
        .filter(function(s) { return s.index >= dayStart && s.index <= dayEnd && s.price < Infinity && s.price <= maxPrice; })
        .slice();
      // Sort by price ascending
      dayCandidates.sort(function(a, b) { return a.price - b.price; });
      // Pick up to perDayLimit cheapest within this day
      for (var j = 0; j < Math.min(perDayLimit, dayCandidates.length); j++) {
        var idx = dayCandidates[j].index;
        if (idx >= 0 && idx < states.length) states[idx] = 1;
      }
    }
  }

  return { states, labels: formattedLabels, rawLabels: totalLabels };
}

/*
 * renderShellyStateChart(id, states, labels, rawLabels, currentSlotIndex, timeFrame)
 * -----------------------------------------------------------------------------
 * Render or update a per-device compact chart that visualizes scheduled ON
 * / OFF slots. The chart keeps a mapping to `rawLabels` (ISO timestamps)
 * to allow precise current-slot highlighting in `updateShellyStatus`.
 */
function renderShellyStateChart(id, states, labels, rawLabels, currentSlotIndex, timeFrame) {
  const slotsPerPeriod = timeFrame === '1hour' ? 4 : timeFrame === '30min' ? 2 : 1;
  // Determine the current period index carefully by matching the exact ISO slot
  // timestamp (so we don't accidentally mark the same HH:MM on a different day).
  let currentPeriodIndex = -1;
  if (typeof currentSlotIndex === 'number' && currentSlotIndex >= 0) {
    try {
      const rpi = window.rawPricesInfo;
      if (rpi && Array.isArray(rpi.combinedLabels) && rpi.combinedLabels[currentSlotIndex]) {
        const currentIso = rpi.combinedLabels[currentSlotIndex];
        if (Array.isArray(rawLabels)) {
          currentPeriodIndex = rawLabels.indexOf(currentIso);
        }
      }
    } catch (e) {
      console.warn('Failed to compute currentPeriodIndex by ISO match:', e);
    }
    // Fallback to numeric division when ISO matching didn't find an index
    if (currentPeriodIndex === -1) {
      currentPeriodIndex = Math.floor(currentSlotIndex / slotsPerPeriod);
    }
  }

  const canvas = document.getElementById(`stateChart${id}`);
  if (!canvas) {
    console.error(`State chart canvas for Shelly ${id} not found in DOM`);
    return;
  }

  const rootStyles = getComputedStyle(document.documentElement);
  const primaryColor = rootStyles.getPropertyValue('--primary-color').trim() || '#00ff00';
  const offColor = rootStyles.getPropertyValue('--off-color').trim() || '#808080';
  const currentBorderColor = rootStyles.getPropertyValue('--current-color').trim() || '#ff0000';
  // Keep both ON and OFF bars visible by using a uniform height (1) for every period,
  // and use colors to indicate ON vs OFF. This preserves the visual grid while
  // allowing tooltip to show the true state from `states` array.
  const displayData = states.map(() => 1);
  const backgroundColors = states.map((state) => (state === 1 ? primaryColor : offColor));
  const borderColors = states.map((state, i) =>
    i === currentPeriodIndex ? currentBorderColor : (state === 1 ? primaryColor : offColor)
  );
  const borderWidths = states.map((state, i) => (i === currentPeriodIndex ? 2 : 1));

  if (stateCharts[id] && Chart.getChart(canvas)) {
    const chart = stateCharts[id];
    chart.data.labels = labels;
    chart.data.datasets[0].data = displayData;
    chart.data.datasets[0].backgroundColor = backgroundColors;
    chart.data.datasets[0].borderColor = borderColors;
    chart.data.datasets[0].borderWidth = borderWidths;
    chart.options.plugins.title.text = `Shelly ${id} Active Slots (${timeFrame === '1hour' ? '1-hour' : timeFrame === '30min' ? '30-min' : '15-min'})`;
    chart.update();
    // keep rawLabels on the chart for later mappings (used by updateShellyStatus)
    chart._rawLabels = rawLabels;
  } else {
    stateCharts[id] = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: `Shelly ${id} State (ON/OFF)`,
          data: displayData,
          backgroundColor: backgroundColors,
          borderColor: borderColors,
          borderWidth: borderWidths
        }]
      },
      options: {
        scales: {
          y: {
            beginAtZero: true,
            max: 1,
            ticks: {
              stepSize: 1,
              callback: () => '' // Hide y-axis labels
            },
            title: { display: true, text: 'State' }
          },
          x: {
            title: { display: true, text: 'Time' },
            ticks: {
              maxRotation: 45,
              minRotation: 45,
              callback: function(value, index) {
                return index % (timeFrame === '1hour' ? 2 : timeFrame === '30min' ? 4 : 8) === 0 ? this.getLabelForValue(value) : '';
              }
            }
          }
        },
        plugins: {
          title: { display: true, text: `Shelly ${id} Active Slots (${timeFrame === '1hour' ? '1-hour' : timeFrame === '30min' ? '30-min' : '15-min'})` },
          tooltip: {
            callbacks: {
              title: function(context) {
                    const idx = context[0].dataIndex;
                    // Prefer raw ISO labels when available
                    let timeIso = (rawLabels && rawLabels[idx]) ? rawLabels[idx] : labels[idx];
                    let displayTime;
                    try {
                      const d = new Date(timeIso);
                      if (!isNaN(d.getTime())) {
                        displayTime = d.toLocaleString(UI_LOCALE, {
                          timeZone: UI_TIMEZONE,
                          year: 'numeric',
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: UI_TIME_FORMAT === '12h'
                        });
                      } else {
                        // Fallback: labels may already be formatted strings like 'HH:MM'
                        displayTime = labels[idx];
                      }
                    } catch (e) {
                      displayTime = labels[idx];
                    }
                    return displayTime + (idx === currentPeriodIndex ? ' (Current)' : '');
                  },
                  label: function(context) {
                    const stateVal = states[context.dataIndex];
                    return stateVal === 1 ? 'ON' : 'OFF';
                  }
            }
          }
        }
      }
    });
    // store rawLabels alongside chart for later lookups
    stateCharts[id]._rawLabels = rawLabels;
  }
}

// Export functions for use in other modules
window.ChartModule = {
  fetchPrices,
  isPricesAvailable,
  getRawPricesInfo,
  renderChart,
  calculateShellyStates,
  renderShellyStateChart,
  UI_TIMEZONE
};