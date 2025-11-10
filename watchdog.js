//crontab -e -> add the line:
//*/5 * * * * /usr/bin/node /home/home-control-center/watchdog.js >> /home/home-control-center/logs/watchdog.log 2>&1
//This script checks if the Home Control Center server is up and sends Telegram notifications if it's down.

const axios = require('axios');
const { SERVER_IP, SERVER_PORT } = require('./configLoader');
const { sendTelegramMessage } = require('./notificationManager');
const { isServerNotified, setServerNotified, clearServerNotified } = require('./notificationState');

/*
 * TIMEOUT_MS
 * ----------
 * Maximum time to wait for a response from the server when running the
 * watchdog check (milliseconds).
 */
const TIMEOUT_MS = 5000; // wait max 5 seconds for response

/*
 * checkServer()
 * -------------
 * Simple health probe that calls the server's `/api/status` endpoint. If
 * the server does not respond or returns an unexpected status, a Telegram
 * notification is sent (with deduplication using notificationState).
 */
async function checkServer() {
  const url = `http://${SERVER_IP}:${SERVER_PORT}/api/status`;
  try {
    const res = await axios.get(url, { timeout: TIMEOUT_MS });
    if (res.status === 200) {
      console.log(`[OK] Server responded at ${new Date().toISOString()}`);
      // If we had previously notified that server was down, clear state and optionally notify recovery
      if (isServerNotified()) {
        console.log('Server recovered; clearing notified state and sending recovery message');
        clearServerNotified();
        await sendTelegramMessage('✅ Home Control Center server is back online');
      }
      return;
    }
    if (!isServerNotified()) {
      await sendTelegramMessage(`⚠️ Server unhealthy: ${JSON.stringify(res.data)}`);
      setServerNotified();
    } else {
      console.log('Server unhealthy but already notified; skipping repeated message');
    }
  } catch (err) {
    if (!isServerNotified()) {
      await sendTelegramMessage(`🚨 Server appears DOWN! (${err.message})`);
      setServerNotified();
    } else {
      console.log('Server down but already notified; skipping repeated message');
    }
  }
}

checkServer();
