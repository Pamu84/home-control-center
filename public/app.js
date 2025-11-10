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

function setUiTimezone(tz) {
  try {
    UI_TIMEZONE = tz || UI_TIMEZONE;
    localStorage.setItem('uiTimeZone', UI_TIMEZONE);
    // Trigger immediate UI refresh where possible
    try {
      if (window.lastFetchedPrices) renderChart(window.lastFetchedPrices, document.getElementById('chartTimeFrame').value || '15min');
    } catch (e) {}
    try {
      // Recompute and redraw per-device charts
      const containers = document.querySelectorAll('.shelly-container');
      const rpi = window.rawPricesInfo;
      containers.forEach(container => {
        const id = container.dataset.id;
        const settings = JSON.parse(localStorage.getItem(`shellySettings_${id}`)) || {};
        if (rpi) {
          const { states, labels, rawLabels } = calculateShellyStates(rpi, settings, settings.manualOverride);
          renderShellyStateChart(id, states, labels, rawLabels, rpi.currentSlotIndex, settings.timeFrame);
        }
        // Update status panel text
        try { updateShellyStatus(id); } catch (e) {}
      });
    } catch (e) {}
  } catch (e) { console.warn('Failed to set UI timezone:', e); }
}

/*
 * fetchPrices()
 * -------------
 * Fetch the cached prices payload from the server (`/api/prices`). Returns
 * an object { today: [...], tomorrow: [...] } or { today: [], tomorrow: [] }
 * on error. The charting and scheduling logic consumes this shape.
 */
async function fetchPrices() {
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
 * priceChart
 * ----------
 * Global Chart.js instance used to render the price bar chart. Persisted at
 * module scope so subsequent updates can call `priceChart.update()`.
 */
let priceChart = null;

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
      const dateStr = dayIndex === 0 ? todayStr : prices.tomorrow[0]?.time.split('T')[0] || todayStr;
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

  // Update or create chart
  if (priceChart && Chart.getChart(canvas)) {
    priceChart.data.labels = formattedLabels;
    priceChart.data.datasets[0].data = displayData;
    priceChart.data.datasets[0].backgroundColor = backgroundColors;
    priceChart.data.datasets[0].borderColor = borderColors;
    priceChart.options.plugins.title.text = titleText;
    priceChart.options.scales.y.max = yAxisMax;
    priceChart.update();
  } else {
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
                const eestTime = new Date(utcTime).toLocaleString(UI_LOCALE, {
                  timeZone: UI_TIMEZONE,
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: UI_TIME_FORMAT === '12h'
                });
                return eestTime + (dataIndex === currentSlotIndex ? ' (Current)' : '');
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
 * stateCharts
 * -----------
 * Caches Chart.js instances for per-device state charts so they can be
 * updated without recreating the chart DOM elements.
 */
let stateCharts = {};

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
      const prices = await fetchPrices();
      const rawPricesInfo = getRawPricesInfo(prices);
  const { states, labels, rawLabels } = calculateShellyStates(rawPricesInfo, settings, settings.manualOverride);
  renderShellyStateChart(id, states, labels, rawLabels, rawPricesInfo.currentSlotIndex, settings.timeFrame);
      updateShellyStatus(id);
    } catch (e) {
      console.warn('Failed to refresh UI after manual control:', e);
    }
  } catch (error) {
    console.error('Manual control failed:', error.message);
  }
}

/*
 * syncRulesToShelly(id, rules)
 * -----------------------------
 * POST the provided `rules` (settings) to /api/sync-rules for the device.
 * This is used at initialization and after settings changes to ensure the
 * device-side script receives up-to-date configuration.
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

// NOTE: Force-refresh UI and server-side nudges were removed. Devices
// pull configuration from /api/config/:id on their own schedule; to avoid
// creating connection noise we no longer attempt to force a refresh from
// the browser. Keep syncRulesToShelly() for normal save flows.

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
          const calc = calculateShellyStates(rpi, settings || {}, settings ? settings.manualOverride : false);
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
      const chart = stateCharts[id];
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
              const calc = calculateShellyStates(rpi, settings || {}, settings ? settings.manualOverride : false);
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

(async function init() {
  try {
    const prices = await fetchPrices();
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
  const rawPricesInfo = getRawPricesInfo(prices);
  window.rawPricesInfo = rawPricesInfo;
  // Initialize timezone selector from localStorage
  try {
    const tzEl = document.getElementById('timezoneSelect');
    if (tzEl) {
      tzEl.value = localStorage.getItem('uiTimeZone') || UI_TIMEZONE;
      tzEl.addEventListener('change', (e) => {
        setUiTimezone(e.target.value);
      });
    }
  } catch (e) { console.warn('Failed to initialize timezone select:', e); }
    renderChart(prices, chartTimeFrame);

    // Add event listener for chart time frame changes
    document.getElementById('chartTimeFrame').addEventListener('change', async (e) => {
      chartTimeFrame = e.target.value;
      localStorage.setItem('chartTimeFrame', chartTimeFrame);
      const freshPrices = await fetchPrices();
      renderChart(freshPrices, chartTimeFrame);
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
                  <button type="button" onclick="manualControl('${id}', 'on')">Turn ON</button>
                  <button type="button" onclick="manualControl('${id}', 'off')">Turn OFF</button>
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
      let savedSettings = await loadSettingsFromServer(id);
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
      updateShellyStatus(id);

  const { states, labels, rawLabels } = calculateShellyStates(rawPricesInfo, savedSettings, savedSettings.manualOverride);
  renderShellyStateChart(id, states, labels, rawLabels, rawPricesInfo.currentSlotIndex, savedSettings.timeFrame);

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
        await saveSettingsToServer(id, settings);
        console.log(`Settings saved for Shelly ${id}:`, settings);
        // Push settings to server and prompt device to refresh immediately
        try {
          await syncRulesToShelly(id, settings);
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
        
  const { states, labels, rawLabels } = calculateShellyStates(rawPricesInfo, settings, settings.manualOverride);
  renderShellyStateChart(id, states, labels, rawLabels, rawPricesInfo.currentSlotIndex, settings.timeFrame);
        updateShellyStatus(id); // Update status after settings change
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
        await saveSettingsToServer(id, settings);
        // Prompt device to refresh immediately
        try { await syncRulesToShelly(id, settings); } catch (e) { console.warn('Failed to push manualOverride change to device:', e); }
  const { states, labels, rawLabels } = calculateShellyStates(rawPricesInfo, settings, settings.manualOverride);
  renderShellyStateChart(id, states, labels, rawLabels, rawPricesInfo.currentSlotIndex, settings.timeFrame);
        updateShellyStatus(id); // Update status after manual override change
      });
      // Reversed control change: persist immediately
      form.querySelector(`#reversedControl${id}`).addEventListener('change', async (e) => {
        const settings = JSON.parse(localStorage.getItem(`shellySettings_${id}`)) || {};
        settings.reversedControl = !!e.target.checked;
        localStorage.setItem(`shellySettings_${id}`, JSON.stringify(settings));
        await saveSettingsToServer(id, settings);
        // Try to fetch the latest device status on-demand and update the UI
        // immediately so the relay/logical state reflects recent changes.
        try {
          const resp = await fetch(`/api/shelly-status/${id}`);
          if (resp.ok) {
            const deviceStatus = await resp.json();
            updateShellyStatus(id, deviceStatus);
          } else {
            // fallback to regular aggregated status refresh
            updateShellyStatus(id);
          }
        } catch (err) {
          console.warn('Failed to fetch on-demand shelly-status:', err);
          updateShellyStatus(id);
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
        const freshPrices = await fetchPrices();
        // update last fetched prices for potential timezone re-renders
        window.lastFetchedPrices = freshPrices;
        const freshRawPricesInfo = getRawPricesInfo(freshPrices);
        window.rawPricesInfo = freshRawPricesInfo;
        renderChart(freshPrices, chartTimeFrame);

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
            const { states, labels, rawLabels } = calculateShellyStates(freshRawPricesInfo, settings, settings.manualOverride);
            renderShellyStateChart(id, states, labels, rawLabels, freshRawPricesInfo.currentSlotIndex, settings.timeFrame);
            // Provide the pre-fetched status for faster UI updates
            updateShellyStatus(id, allStatuses[id]);
          } else {
            // If no settings exist, try to load them and update the UI
            try {
              const serverSettings = await loadSettingsFromServer(id);
              if (serverSettings && Object.keys(serverSettings).length > 0) {
                localStorage.setItem(`shellySettings_${id}`, JSON.stringify(serverSettings));
                const { states, labels, rawLabels } = calculateShellyStates(freshRawPricesInfo, serverSettings, serverSettings.manualOverride);
                renderShellyStateChart(id, states, labels, rawLabels, freshRawPricesInfo.currentSlotIndex, serverSettings.timeFrame);
                updateShellyStatus(id, allStatuses[id]);
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
      const freshPrices = await fetchPrices();
      window.lastFetchedPrices = freshPrices;
      const freshRawPricesInfo = getRawPricesInfo(freshPrices);
      window.rawPricesInfo = freshRawPricesInfo;
      renderChart(freshPrices, chartTimeFrame);

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
          const { states, labels, rawLabels } = calculateShellyStates(freshRawPricesInfo, settings, settings.manualOverride);
          renderShellyStateChart(id, states, labels, rawLabels, freshRawPricesInfo.currentSlotIndex, settings.timeFrame);
          updateShellyStatus(id, allStatuses[id]);
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