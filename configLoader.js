const fs = require('fs');
const path = require('path');

// Strict runtime config loader: prefer a user-provided config.json at the
// project root. This file is expected to be gitignored and contain all
// environment-specific secrets (telegram tokens, camera creds, etc.).
const cfgPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(cfgPath)) {
  throw new Error('Missing runtime config.json. Copy config.template.json to config.json and fill your secrets.');
}

let raw = null;
try {
  raw = fs.readFileSync(cfgPath, 'utf8');
} catch (e) {
  throw new Error('Failed to read config.json: ' + e.message);
}

let cfg = null;
try {
  cfg = JSON.parse(raw);
} catch (e) {
  throw new Error('Invalid JSON in config.json: ' + e.message);
}

module.exports = cfg;
