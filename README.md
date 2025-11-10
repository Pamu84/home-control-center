# Home Control Center

## Introduction

This repository contains a personal hobby project I build and maintain in my spare time. It's intended as a practical, working example of integrating Shelly devices with day-ahead electricity prices — not as a commercial or professionally supported product. If you download and run this project, please treat it as experimental: review configuration and code before exposing it to your network, keep secrets out of the repository, and expect occasional rough edges or TODOs.

The **Home Control Center** is a Node.js-based application designed to manage smart home devices, specifically Shelly switches, with integration for Nord Pool electricity price data from the Elering API. The system fetches day-ahead electricity prices for Finland, processes them into 15-minute intervals, and enables both manual and automated control of Shelly devices based on price thresholds or the cheapest time slots. The web interface provides a visual chart of electricity prices and a form to configure control settings for each Shelly device.

This project is built with JavaScript, HTML, and CSS, using Express.js for the backend, Chart.js for visualizations, and Axios for HTTP requests. It is designed to be extensible, with plans for future integration of ESP32 devices.

### Getting Started

#### Project Structure
The project is organized as follows:

- **Root Directory**:
  - `server.js`: Sets up the Express.js server, serving static files and providing API endpoints for price data and Shelly control.
  - `energyPrices.js`: Fetches and processes electricity price data from the Elering API, saving it to `prices.json`.
  - `shellyController.js`: Contains functions to turn Shelly devices on or off via HTTP requests.
  - `package.json`: Defines project metadata, dependencies, and scripts for running the application.
  - `prices.json`: Stores processed electricity price data for today and tomorrow.

- **public/** (Frontend assets):
  - `index.html`: The main HTML file for the user interface, including the price chart and Shelly control forms.
  - `js/settings.js`: Settings management module for loading, saving, and syncing device settings.
  - `js/chart.js`: Chart rendering and data visualization module for price charts and device state charts.
  - `js/deviceControl.js`: Device control module for manual operations and status updates.
  - `js/ui.js`: UI initialization and management module.
  - `styles.css`: CSS styles for the web interface.

-#### Prerequisites
- **Node.js**: Version 18 (LTS) or higher is recommended. Recent Node releases include the global `fetch` API used by the project and provide better compatibility for dependencies.
- **npm**: Node package manager for installing dependencies.
- **Shelly Devices**: Configured Shelly switches (e.g., Shelly Plus/Pro series) with known IP addresses on your local network, supporting Shelly Script for offline operation.
- **Internet Access**: Required for fetching price data from the Elering API.
- **Favicon**: A `favicon.ico` file (e.g., 16x16 or 32x32 pixels) placed in the `public` directory.


Installation
1. Clone the Repository (if in GIT!)

git clone <repository-url>
cd home-control-center

2. Install Dependencies:
Run the following command to install required packages (listed in package.json):

npm install

3. Configure Shelly Devices (recommended via UI)

The preferred and easiest way to add Shelly devices is through the web UI's Settings tab (no manual file edits required):

- Open the app at http://localhost:3000 and go to the Settings tab.
- Use the "Add New Shelly Switch" form to provide a name and the device IP. The server will persist this to the runtime `config.json` and the UI will create the device panel automatically.
- After adding, a device panel will appear where you can set per-device rules (min/max price, cheapest slots, time frame) and push those rules to the Shelly device.

Manual JSON editing (optional):

- If you prefer to edit files directly, you can still add entries to `config.json` (or `config.template.json`) under `shellyDevices`. The server will read runtime `config.json` on startup.

Installing the Shelly Script on the device:

- The server provides a patched Shelly script that embeds the correct server address and device id. In the Settings UI there is a "Show Script" action (or you can GET `/api/get-script?id=<id>`) which returns the script text.
- Copy the patched script into the Shelly web UI (Scripts -> add script id=1) or use the Shelly device's script editor, save and enable it. No manual string replacements should be required when using the provided script.

4. Price data (automatic)

The server fetches price data automatically on startup and then periodically using a scheduled job (every 15 minutes by default). You do not need to run `energyPrices.js` manually in normal operation — it is only useful for seeding `prices.json` during development or if you want to force a fresh fetch immediately from the command line.

Optional (dev):

```bash
# seed prices locally (development)
node energyPrices.js
```

5. Start the Server:
Launch the Express.js server to serve the web interface and API:

npm start

Alternatively, for development with auto-restart on file changes:

npm run dev

6. Access the Application:
Open a browser and navigate to http://localhost:3000 to view the web interface, including the price chart and Shelly control forms.

### Running with PM2 (optional)

If you want the server to run as a managed background process with auto-restart and logs, you can use PM2.

1. Install pm2 globally (if not installed):

```bash
npm install -g pm2
```

2. Start processes with the included ecosystem file:

```bash
pm2 start ecosystem.config.js --env production
```

This will start two processes defined in `ecosystem.config.js`:
- `home-control-center` — the main Express server (`server.js`). Auto-restarts on crash.
- `home-control-watchdog` — the watchdog script (`watchdog.js`). It's configured with `cron_restart` so pm2 will run it on the schedule configured (default: every minute). The watchdog is configured with `autorestart: false` so pm2 won't immediately restart it after it exits — PM2 will only restart it according to the `cron_restart` schedule.

3. Useful pm2 commands:

```bash
pm2 status                 # list processes
pm2 logs home-control-center --lines 200
pm2 logs home-control-watchdog --lines 200
pm2 stop home-control-center
pm2 restart ecosystem.config.js
pm2 save                   # save current process list for resurrect
pm2 startup                # generate startup script for your system
```

Notes:
- Adjust the `cron_restart` value in `ecosystem.config.js` if you want a different watchdog interval (e.g., `*/5 * * * *` for every 5 minutes).
- If you prefer to run `watchdog.js` with system cron instead of pm2 scheduling, remove the `home-control-watchdog` app and keep the cron entry pointing to `node /path/to/watchdog.js`.
- PM2 provides more robust process management (auto-restart, logs, startup scripts) and is recommended for production deployments.

### Running the System
- Price Updates: The server (server.js) automatically fetches and updates prices.json every hour using node-cron, ensuring continuous price data for automated Shelly control. Prices are also fetched on server startup.
- Rule Synchronization: The server synchronizes control rules (minPrice, maxPrice, numCheapest, timeFrame, manualOverride) with Shelly devices every 4 hours using node-cron. Rules are also synced when updated via the web interface.
- Shelly Operation:
    * Online Mode: When the server is reachable, Shellys use prices from /api/prices and apply server-sent rules or direct control commands.
    * Offline Mode: When the server is offline, Shellys fetch prices directly from the Elering API and apply the last synchronized rules, ensuring continuous operation.
- Web Interface: The interface at http://localhost:3000 displays:
    * A Chart.js bar chart of electricity prices for today and tomorrow (15-minute intervals) with x-axis labels in HH:MM format (e.g., 16:30).
    * For each Shelly device, a chart showing on/off states (ON = bar, OFF = no bar) for slots based on the selected time frame, with x-axis labels in HH:MM format.
    * Forms to set minimum/maximum price thresholds, number of cheapest slots, time frame (15min, 30min, 1hour), and a manual override toggle for each device.
- Automated Control: The system checks prices every minute (via the frontend modules) and applies user-defined rules to turn Shelly devices on or off when the server is online. Shellys handle control locally when the server is offline.

### Important Considerations
- Shelly Device IPs: Ensure the IP addresses in shellyController.js are correct and static (or use a DHCP reservation) to avoid connectivity issues.
- Network Security: Shelly devices are controlled via HTTP requests. Ensure your network is secure, and consider using HTTPS or a VPN for remote access.
- API Reliability: The Elering API may occasionally fail or return incomplete data. The system handles this by filling missing data with zero prices, but you should monitor logs for errors.
- Time Zones: Prices are fetched in UTC and displayed in EEST (Finland, UTC+3) in the chart. Ensure your system’s time is accurate for correct slot calculations.
 - Time Zones: Prices are fetched in UTC. The web UI includes a Time Zone selector (Settings) so you can choose how times are displayed (default: `Europe/Helsinki`). Ensure your system’s time is accurate for correct slot calculations; the UI display will follow the selected timezone.
- Future Expansions: To integrate ESP32 devices, you'll need to extend shellyController.js or create a new module for ESP32 communication protocols (e.g., MQTT or HTTP).
- Dependencies: Keep dependencies (axios, express, chart.js, etc.) updated for security and performance. Check package.json for the full list.

## Logging System

The Home Control Center implements a comprehensive logging system using Winston, providing structured logging, log rotation, and multiple output destinations for effective monitoring and debugging.

### Log Levels

The system uses standard logging levels with the following hierarchy (from highest to lowest priority):

- **error**: Critical errors that require immediate attention (application crashes, failed API calls, device communication failures)
- **warn**: Warning conditions that should be reviewed (retry attempts, degraded performance, configuration issues)
- **info**: General informational messages (successful operations, state changes, periodic status updates)
- **debug**: Detailed diagnostic information (API request/response details, internal state changes)

### Log Files and Rotation

Logs are automatically organized and rotated to prevent disk space issues:

```
logs/
├── app-YYYY-MM-DD.log          # General application logs (all levels)
├── error-YYYY-MM-DD.log        # Error-only logs (error + warn levels)
├── exceptions.log              # Uncaught exceptions
├── rejections.log              # Unhandled promise rejections
└── .audit.json                 # Winston rotation metadata
```

**Key Features:**
- **Daily Rotation**: New log files are created each day with date stamps
- **Size Limits**: Files are rotated when they reach 20MB
- **Retention**: Logs are kept for 14 days (application logs) or 30 days (error logs)
- **Compression**: Old log files can be compressed to save space

### Console vs File Logging

- **Development**: Console output shows colored, human-readable logs for immediate feedback
- **Production**: File logging captures structured JSON data for analysis and monitoring
- **Both**: All environments write to both console and files simultaneously

### Module-Specific Logging

Each major component uses dedicated child loggers for better organization:

- **energyPrices**: Price fetching operations, API calls, data processing
- **notificationManager**: Telegram message sending, delivery confirmations
- **shellyLogger**: Device status logging, file operations
- **server**: HTTP requests, API responses, system events

### Viewing Logs

#### Real-time Monitoring

```bash
# View live application logs
tail -f logs/app-$(date +%Y-%m-%d).log

# View live error logs only
tail -f logs/error-$(date +%Y-%m-%d).log

# Monitor with colored output (development)
npm run dev  # Shows colored console logs
```

#### Log Analysis

```bash
# Search for specific events
grep "device.*online" logs/app-$(date +%Y-%m-%d).log

# Count errors in the last 24 hours
grep '"level":"error"' logs/error-$(date +%Y-%m-%d).log | wc -l

# Find price fetching failures
grep "Failed to fetch price data" logs/app-$(date +%Y-%m-%d).log

# Check device heartbeat patterns
grep "heartbeat" logs/app-$(date +%Y-%m-%d).log | head -10
```

#### PM2 Log Integration

When running with PM2, logs are also available through PM2 commands:

```bash
# View PM2-managed logs
pm2 logs home-control-center --lines 100

# Follow logs in real-time
pm2 logs home-control-center --follow

# Search PM2 logs
pm2 logs home-control-center --grep "error"
```

### Log Configuration

#### Environment Variables

Control logging behavior with environment variables:

```bash
# Set log level (default: info)
LOG_LEVEL=debug npm start

# Available levels: error, warn, info, debug
```

#### Log Format

**Console Format** (development):
```
2025-11-10 14:30:15 [info]: Energy prices successfully updated {"module":"energyPrices"}
```

**File Format** (JSON):
```json
{
  "level": "info",
  "message": "Energy prices successfully updated",
  "module": "energyPrices",
  "timestamp": "2025-11-10 14:30:15"
}
```

### Common Log Messages

#### Successful Operations
```
[info]: Energy prices successfully updated
[info]: Telegram message sent successfully
[info]: Shelly Logger started successfully
[info]: Config synced: prices=96, schedule=96
```

#### Warnings and Retries
```
[warn]: Attempt 1 failed, retrying in 1000ms
[warn]: No data available for 2025-11-11, returning zero-filled slots
[warn]: Failed to fetch switch status
```

#### Errors
```
[error]: Failed to fetch price data after retries
[error]: Telegram configuration missing
[error]: Config validation/parse error
```

#### Debug Information
```
[debug]: Fetching prices from API
[debug]: Sending Telegram message
[debug]: Switch status fetched successfully
```

### Monitoring and Alerting

#### Health Check Endpoint

Monitor system health via the `/health` endpoint:

```bash
curl http://localhost:3000/health
```

Returns system status including:
- Service uptime
- Price data freshness
- Device connectivity status
- Overall system health (healthy/degraded/unhealthy)

#### Metrics Endpoint

Get Prometheus-compatible metrics:

```bash
curl http://localhost:3000/metrics
```

Includes metrics for:
- System uptime
- Price data statistics
- Device connectivity
- Heartbeat monitoring

#### Log-Based Monitoring

Set up log monitoring for critical events:

```bash
# Monitor for critical errors
tail -f logs/error-$(date +%Y-%m-%d).log | grep -E "(error|Error)"

# Alert on device offline events
tail -f logs/app-$(date +%Y-%m-%d).log | grep "device.*offline"

# Track API failures
tail -f logs/app-$(date +%Y-%m-%d).log | grep "Failed to fetch"
```

### Troubleshooting with Logs

#### Price Data Issues
```bash
# Check for price fetching problems
grep "energyPrices" logs/app-$(date +%Y-%m-%d).log | tail -20

# Verify API response details
grep "Successfully fetched price data" logs/app-$(date +%Y-%m-%d).log
```

#### Device Communication Problems
```bash
# Check device connectivity
grep "shellyLogger" logs/app-$(date +%Y-%m-%d).log | tail -20

# Find heartbeat failures
grep "Heartbeat failed" logs/app-$(date +%Y-%m-%d).log
```

#### Notification Issues
```bash
# Check Telegram delivery
grep "notificationManager" logs/app-$(date +%Y-%m-%d).log | tail -10

# Verify configuration
grep "Telegram configuration missing" logs/error-$(date +%Y-%m-%d).log
```

#### Performance Analysis
```bash
# Check response times
grep "responseTime\|duration" logs/app-$(date +%Y-%m-%d).log

# Monitor memory usage (if available)
grep "memory\|heap" logs/app-$(date +%Y-%m-%d).log
```

### Log Maintenance

#### Manual Cleanup
```bash
# Remove old logs manually (be careful!)
find logs/ -name "*.log" -mtime +30 -delete

# Compress old logs to save space
find logs/ -name "app-*.log" -mtime +7 -exec gzip {} \;
```

#### Log Rotation Tuning

Modify log rotation settings in `utils/logger.js`:
- `maxSize`: Maximum file size before rotation
- `maxFiles`: Retention period
- `datePattern`: Date format for file names

### Best Practices

1. **Log Level Management**: Use `LOG_LEVEL=debug` for troubleshooting, `info` for normal operation
2. **Regular Monitoring**: Check logs daily for warnings and errors
3. **Alert Setup**: Configure alerts for error-level messages
4. **Log Retention**: Ensure sufficient disk space for log retention
5. **Structured Data**: Include relevant context in log messages for better debugging
6. **Performance**: Be mindful of debug logging in production (high volume)

### Log Examples

#### Normal Operation
```
2025-11-10 06:00:00 [info]: Starting energy prices fetch operation {"module":"energyPrices"}
2025-11-10 06:00:01 [info]: Successfully fetched price data {"module":"energyPrices","start":"2025-11-10T00:00:00.000Z","end":"2025-11-10T23:59:59.999Z","entries":92}
2025-11-10 06:00:01 [info]: Processed price data for 2025-11-10 {"module":"energyPrices","totalSlots":96,"nonZeroSlots":92}
2025-11-10 06:00:01 [info]: Energy prices successfully updated and saved {"module":"energyPrices"}
```

#### Error Recovery
```
2025-11-10 06:00:00 [warn]: Attempt 1 failed, retrying in 1000ms {"module":"energyPrices","error":"API request failed: 500"}
2025-11-10 06:00:01 [info]: Successfully fetched price data {"module":"energyPrices","start":"2025-11-10T00:00:00.000Z","end":"2025-11-10T23:59:59.999Z","entries":92}
```

#### Device Issues
```
2025-11-10 12:30:15 [warn]: Failed to fetch switch status {"module":"shellyLogger","ip":"192.168.1.236","error":"Timeout"}
2025-11-10 12:30:15 [info]: Device status logged to file {"module":"shellyLogger","deviceId":"1","logFile":"shelly_logger.txt"}
```

## Running on a Raspberry Pi

This project runs well on Raspberry Pi models (Pi 3, 4 or 400). The recommended deployment is Raspberry Pi OS (Debian based). The main considerations are installing Node.js for ARM, ffmpeg for camera streaming, and keeping `config.json` (runtime secrets) out of git.

Quick overview:
- Install OS and required packages (Node.js, ffmpeg, git).
- Clone the repository, copy `config.template.json` -> `config.json` and fill secrets.
- Install npm dependencies and seed prices (optional for dev).
- Set up a systemd service or use `pm2` to run on boot.

Step-by-step (example for Debian / Raspberry Pi OS):

1) Update system and install prerequisites

```bash
sudo apt update
sudo apt upgrade -y
# Install Node.js (recommended: use NodeSource for an up-to-date release)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs build-essential git ffmpeg

# (Optional) If you prefer latest ffmpeg builds, follow project-specific docs or use a static build.
```

2) Clone the repo and prepare config

```bash
git clone <repo-url> home-control-center
cd home-control-center
cp config.template.json config.json
# Edit config.json and fill TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and camera creds (under _cameraCreds or videoCameras)
nano config.json
```

3) Install dependencies and (optionally) seed prices for dev

```bash
npm install
# For development seed (creates prices.json):
node energyPrices.js
```

4) Run the server (development)

```bash
npm run dev
# or
node server.js
```

5) Create a systemd service (recommended for Pi deployments)

Create `/etc/systemd/system/home-control-center.service` with the following content (adjust paths/user):

```ini
[Unit]
Description=Home Control Center
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/home-control-center
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable home-control-center.service
sudo systemctl start home-control-center.service
sudo journalctl -u home-control-center -f
```

Alternative process managers
- pm2: `npm install -g pm2` then `pm2 start server.js --name home-control-center` and `pm2 save && pm2 startup`.

Verification
- Visit the server UI in your browser: http://<pi-ip>:3000
- Test camera endpoints: GET /api/cameras and /camera/:id/stream
- Test notifications by triggering a known notification in the app or calling the relevant API endpoint.

Notes and tips
- Architecture: on Pi it's best to keep `config.json` in the project root and ensure it's included in `.gitignore` (it is by default). Don't commit secrets.
- Performance: ffmpeg can be CPU-intensive; for many simultaneous camera streams consider a more powerful Pi (Pi 4 or Pi 400) or an external streaming proxy.
- Swap: if you run into memory issues during `npm install` on older Pis, temporarily enable a small swap file while building and remove it afterwards.
- Security: put the Pi behind a firewall and avoid exposing the admin UI directly to the internet. If remote access is needed, use a VPN or SSH tunnel.

## Configuration & Secrets

Sensitive values (camera credentials, Telegram bot token / chat id, and any private IPs) must not be committed to the repository. This project uses a JSON template and a runtime `config.json` file for operator-friendly configuration:

- `config.template.json` (committed) — An example/template file with placeholder values. Edit this to learn which fields are required.
- `config.json` (runtime, gitignored) — The real runtime configuration file where you put secrets. This file is ignored by Git (see `.gitignore`) and is not committed.

Quick steps to create your runtime config safely:

IMPORTANT: The application now requires a valid `config.json` at startup. Create `config.json` from the template before launching the server.

1. Copy the template to create the runtime file:

```bash
cp config.template.json config.json
```

2. Edit `config.json` and fill in real values for:
    - `videoCameras.*.streamUrl` — include camera user/password only in this runtime file.



    - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` — put your bot credentials here.
    - Any other private addresses or tokens your installation needs.

3. Ensure `config.json` is not added to Git:

```bash
git status --porcelain
# if config.json appears, undo accidentally staged file:
git restore --staged config.json
```

4. Restrict file permissions on the server (optional but recommended):

```bash
chmod 600 config.json
chown <your-service-user> config.json
```

If `config.json` is missing when the server starts, the application will try to copy `config.template.json` to `config.json` so you have a starting point. If you ever accidentally commit secrets, rotate them immediately and consider removing them from history (BFG/git-filter-repo) — contact me if you want help with history scrubbing.

Description of each files

### ---- energyPrices.js ----
The energyPrices.js script is responsible for fetching and processing electricity price data from the Elering API for Finland, storing the results in prices.json. It retrieves day-ahead electricity prices for the current and next day, processes them into 15-minute intervals (96 slots per day), and applies a tax multiplier (1.255) to convert prices to cents per kilowatt-hour (c/kWh).
Key Functionality:

- Date Handling: Generates ISO date strings for today and tomorrow to query the Elering API.
- API Fetching: Queries the Elering API (https://dashboard.elering.ee/api/nps/price) for price data within specified time ranges.
- Data Processing: Converts hourly API data into 15-minute slots, filling gaps with zero prices if data is missing.
- Output: Saves processed prices (today and tomorrow arrays) to prices.json for use by other parts of the system.
- Error Handling: Logs errors and returns zero-filled slots if the API request fails.

Usage: This script runs independently to update prices.json periodically, ensuring the system has up-to-date electricity price data for controlling devices like Shelly switches.

### ---- server.js ----
The server.js file sets up an Express.js server to serve the home control system’s web interface and provide API endpoints for price data and Shelly device control.
Key Functionality:

- Static File Serving: Serves static files (e.g., index.html, js/*.js, styles.css) from the public directory.
- API Endpoints:
    * /api/prices: Reads and returns the contents of prices.json, providing electricity price data to the frontend.
    * /api/control: Handles requests to turn Shelly devices on or off based on query parameters (id and action). It calls functions (turnOnShelly, turnOffShelly) from shellyController.js.
- Price Fetching: Uses node-cron to schedule fetchEnergyPrices from energyPrices.js every hour and runs it on server startup.
- Error Handling: Returns appropriate HTTP status codes and error messages if file reading or device control fails.
- Server Configuration: Runs on port 3000 by default, accessible at http://localhost:3000.

Usage: This server acts as the backend for the home control system, enabling the frontend to retrieve price data and send control commands to Shelly devices.

### ---- js/settings.js ----
The settings.js module handles loading, saving, and syncing device settings between the server, localStorage, and Shelly devices.

Key Functionality:
- loadSettingsFromServer(id): Fetches per-device settings from the server (/api/load-settings?id=<id>).
- saveSettingsToServer(id, settings): Persists settings to the server using /api/save-settings.
- syncRulesToShelly(id, rules): POSTs settings to /api/sync-rules for device synchronization.

### ---- js/chart.js ----
The chart.js module handles price data fetching, chart rendering, and state calculations for the main price chart and per-device state charts.

Key Functionality:
- fetchPrices(): Retrieves price data from /api/prices endpoint.
- renderChart(prices, timeFrame): Renders Chart.js bar chart of electricity prices with current slot highlighting.
- calculateShellyStates(pricesInfo, settings, manualOverride): Computes ON/OFF states for device slots based on settings.
- renderShellyStateChart(id, states, labels, rawLabels, currentSlotIndex, timeFrame): Renders per-device state charts.

### ---- js/deviceControl.js ----
The deviceControl.js module handles manual device control operations and status updates for Shelly devices.

Key Functionality:
- manualControl(id, action): Triggers manual ON/OFF control via /api/control endpoint.
- updateShellyStatus(id, overrideStatus): Fetches and updates device status UI elements.

### ---- js/ui.js ----
The ui.js module handles UI initialization and management, including timezone settings and main application setup.

Key Functionality:
- setUiTimezone(tz): Updates global UI timezone and triggers UI refresh.
- Main initialization: Sets up price fetching, chart rendering, device containers, and periodic updates.

### ---- shellyController.js ----

The shellyController.js file provides functions to control Shelly smart switches by sending HTTP requests to their IP addresses. It serves as the interface between the server and Shelly devices, enabling the system to turn devices on or off.
Key Functionality:

- Device Mapping: Maintains a shellyDevices object that maps Shelly device IDs to their corresponding IP addresses (e.g., {"1": "192.168.1.28"}).
- Control Functions:
    * turnOnShelly(id): Sends an HTTP GET request to the Shelly device’s IP (e.g., http://<ip>/relay/0?turn=on) to turn the device on.
    * turnOffShelly(id): Sends an HTTP GET request to the Shelly device’s IP (e.g., http://<ip>/relay/0?turn=off) to turn the device off.

- Error Handling: Validates the device ID, throws an error for unknown devices, and handles network errors with a 5-second timeout using the axios library.
- Logging: Logs successful operations or errors for debugging purposes.

Usage: This module is imported by server.js to handle /api/control endpoint requests, enabling both manual and automated control of Shelly devices based on user input or electricity price rules.


### Configure Shelly Devices
Each Shelly device needs the script from generateShellyScript installed. Follow these steps:

1. Access Shelly Web Interface:
    * Open the Shelly device’s web interface (e.g., http://192.168.1.28 for Shelly 1).
    * Navigate to the “Scripts” section (available on Shelly Plus/Pro devices).
2. Create and Enable Script:
    * Create a new empty script (e.g. script_1).
    * Save and enable the script to start it.
3. Initial Sync:
    * After starting the server, submit the settings form for each Shelly in the HTML interface to trigger an initial rule sync.
    * Alternatively, manually trigger a sync via a POST request:
    curl -X POST http://localhost:3000/api/sync-rules -H "Content-Type: application/json" -d '{"id":"1","rules":{"minPrice":0.05,"maxPrice":0.20,"numCheapest":4,"timeFrame":"15min","manualOverride":false}}'
4. Verify Script Operation:
    * Check the Shelly’s logs or switch status to confirm it’s applying rules.
    * Test server downtime by stopping the server and verifying the Shelly continues controlling itself based on the last rules.

### Configure Reolink Cameras (Object Detection)

This application supports Reolink cameras with AI-powered object detection. You can configure cameras to send webhooks with detected objects (person, vehicle, animal, etc.) and filter motion recordings based on object types.

#### Camera Setup in Reolink App:
1. **Install Reolink App**: Download and set up the Reolink app on your phone.
2. **Add Camera**: Add your RLC-510A camera to the app.
3. **Enable AI Detection**: 
   - Go to camera settings → AI Detection
   - Enable "Person Detection", "Vehicle Detection", etc.
   - Configure detection zones and sensitivity

#### Webhook Configuration:
1. **Set Webhook URL**: In the Reolink app, go to camera settings → Network → Webhook
2. **Webhook URL**: `http://YOUR_SERVER_IP:3000/api/camera-event/CAMERA_ID`
   - Replace `YOUR_SERVER_IP` with your server's IP address
   - Replace `CAMERA_ID` with the camera ID from your `config.json` (e.g., "100")
3. **Webhook Events**: Enable "Motion Detection" events
4. **Test Webhook**: Use the test script to verify:
   ```bash
   node scripts/test_motion_webhook.js 100 http://localhost:3000
   ```

#### Object Detection Webhook Payload:
Reolink cameras send webhooks with object detection data. The system supports these formats:
```json
{
  "event": "motion",
  "score": 85,
  "duration": 10,
  "objects": [
    {"type": "person", "confidence": 0.92}
  ]
}
```
or
```json
{
  "event": "motion", 
  "score": 78,
  "detectedObjects": [
    {"class": "vehicle", "confidenceScore": 0.88}
  ]
}
```

#### Object Filtering Configuration:
1. **Global Settings**: In the Settings tab, set "Global Object Types" (comma-separated)
   - Default: "person,vehicle"
   - Only these object types will trigger recordings
2. **Per-Camera Settings**: Override global settings for specific cameras
   - Leave empty to use global settings
   - Example: "person" (only persons), "vehicle,animal" (vehicles and animals)

#### Testing Object Detection:
```bash
# Test person detection
curl -X POST http://localhost:3000/api/camera-event/100 \
  -H "Content-Type: application/json" \
  -d '{"event":"motion","score":85,"objects":[{"type":"person","confidence":0.92}]}'

# Test vehicle detection  
curl -X POST http://localhost:3000/api/camera-event/100 \
  -H "Content-Type: application/json" \
  -d '{"event":"motion","score":78,"detectedObjects":[{"class":"vehicle","confidenceScore":0.88}]}'

# Test filtered out detection (animal)
curl -X POST http://localhost:3000/api/camera-event/100 \
  -H "Content-Type: application/json" \
  -d '{"event":"motion","score":65,"objects":[{"type":"animal","label":"cat","confidence":0.75}]}'
```

### Shelly-only installation (no cameras)

If you only want to run the application with Shelly devices and omit the camera features and UI tab, follow these minimal steps:

1. Create runtime config from the template and edit it:

```bash
cp config.template.json config.json
# edit config.json and remove or empty the `videoCameras` section
```

2. In `config.json` remove the `videoCameras` object (or set it to an empty object `{}`) and ensure `motionRecordingEnabled` is `false` (or absent). Example snippet:

```json
    "videoCameras": {},
    "motionRecordingEnabled": false
```

3. Start the server normally (`npm start`). The frontend hides the Video Surveillance tab when no camera feature is present.

4. Configure Shelly devices as described above (edit `shellyController.js` or use the Settings UI -> Shelly Devices). You can ignore camera-related files (`modules/cameras/*`, `cameraController.js`, and camera entries in `config.json`).

Notes:
- Removing `videoCameras` or leaving it empty prevents camera initialization and hides the camera tab in the UI.
- If you later want to re-enable cameras, add camera entries back to `config.json` and restart the server.