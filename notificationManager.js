const axios = require('axios');
const { createChildLogger } = require('./utils/logger');
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = require('./configLoader');

const logger = createChildLogger('notificationManager');

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
 * sendTelegramMessage(message)
 * ----------------------------
 * Send a simple text notification via Telegram using the bot token and
 * chat id configured in `config.js`. This is a best-effort helper used by
 * the rest of the system to surface alerts to maintainers.
 *
 * Uses retry logic with exponential backoff for reliability.
 */
async function sendTelegramMessage(message) {
  try {
    // Validate required configuration
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      logger.error('Telegram configuration missing', {
        hasBotToken: !!TELEGRAM_BOT_TOKEN,
        hasChatId: !!TELEGRAM_CHAT_ID
      });
      return false;
    }

    const result = await retryWithBackoff(async () => {
      logger.debug('Sending Telegram message', { messageLength: message.length });

      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
      const response = await axios.post(url, {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      }, {
        timeout: 10000, // 10 second timeout
        headers: {
          'Content-Type': 'application/json'
        }
      });

      // Validate Telegram API response
      if (!response.data || !response.data.ok) {
        throw new Error(`Telegram API error: ${response.data?.description || 'Unknown error'}`);
      }

      return response.data;
    });

    logger.info('Telegram message sent successfully', {
      messagePreview: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
      messageId: result.result?.message_id
    });

    return true;
  } catch (error) {
    logger.error('Failed to send Telegram message after retries', {
      error: error.message,
      messagePreview: message.substring(0, 50) + (message.length > 50 ? '...' : '')
    });
    return false;
  }
}

module.exports = { sendTelegramMessage };
