#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Usage: node scripts/scrub_camera_creds.js [inputConfigPath] [--write-secrets]
const argv = process.argv.slice(2);
const inputPath = argv[0] && argv[0] !== '--write-secrets' ? path.resolve(argv[0]) : path.join(__dirname, '..', 'config.json');
const writeSecrets = argv.includes('--write-secrets');
const cfgPath = inputPath;
if (!fs.existsSync(cfgPath)) {
  console.error('No config.json found at', cfgPath);
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
if (!cfg.videoCameras) {
  console.error('No videoCameras section in config.json');
  process.exit(2);
}

const found = [];
const newCfg = JSON.parse(JSON.stringify(cfg));
Object.keys(newCfg.videoCameras).forEach(id => {
  const cam = newCfg.videoCameras[id];
  if (!cam || !cam.streamUrl) return;
  let parsed = null;
  try { parsed = new URL(cam.streamUrl); } catch (e) { parsed = null; }
  if (parsed) {
    if (parsed.username || parsed.password) {
      const user = parsed.username || '';
      const pass = parsed.password || '';
      const auth = `${user}:${pass}`;
      parsed.username = '';
      parsed.password = '';
      cam.streamUrl = parsed.toString();
      found.push({ id, user, pass, auth });
    } else if (parsed.searchParams && (parsed.searchParams.has('user') || parsed.searchParams.has('password') || parsed.searchParams.has('username'))) {
      const user = parsed.searchParams.get('user') || parsed.searchParams.get('username') || '';
      const pass = parsed.searchParams.get('password') || '';
      const auth = `${user}:${pass}`;
      parsed.searchParams.delete('user');
      parsed.searchParams.delete('username');
      parsed.searchParams.delete('password');
      cam.streamUrl = parsed.toString();
      found.push({ id, user, pass, auth });
    }
  } else {
    const m = cam.streamUrl.match(/^([a-z]+:\/\/)([^@\/\s]+)@(.+)$/i);
    if (m) {
      const creds = m[2];
      const rest = m[3];
      const authParts = creds.split(':');
      const user = authParts[0] || '';
      const pass = authParts[1] || '';
      cam.streamUrl = m[1] + rest;
      found.push({ id, user, pass, auth: `${user}:${pass}` });
    } else {
      const qMatch = cam.streamUrl.match(/([?&])user=([^&]+)&password=([^&]+)/i);
      if (qMatch) {
        const pre = cam.streamUrl.substring(0, qMatch.index);
        const post = cam.streamUrl.substring(qMatch.index + qMatch[0].length);
        cam.streamUrl = pre + post;
        const user = decodeURIComponent(qMatch[2]);
        const pass = decodeURIComponent(qMatch[3]);
        found.push({ id, user, pass, auth: `${user}:${pass}` });
      }
    }
  }
});

const outPath = path.join(path.dirname(cfgPath), 'config.json.scrubbed');
fs.writeFileSync(outPath, JSON.stringify(newCfg, null, 2), 'utf8');
console.log('Wrote scrubbed config to', outPath);

if (found.length === 0) {
  console.log('No credentials found in', cfgPath);
  process.exit(0);
}

console.log('\nDetected camera credentials:');
found.forEach(e => {
  console.log(`# Camera ${e.id}`);
  console.log(` user: ${e.user}`);
  console.log(` pass: ${e.pass}`);
});

if (writeSecrets) {
  const secretsPath = path.join(__dirname, '..', 'camera_credentials.json');
  const credsObj = {};
  found.forEach(e => { credsObj[e.id] = { user: e.user, password: e.pass, auth: e.auth }; });
  fs.writeFileSync(secretsPath, JSON.stringify(credsObj, null, 2), 'utf8');
  console.log('\nWrote camera credentials to', secretsPath);
  // add to .gitignore
  const gi = path.join(__dirname, '..', '.gitignore');
  try {
    let giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!giText.includes('camera_credentials.json')) {
      giText = (giText.trim() ? giText.trim() + '\n' : '') + '# camera credentials (ignored)\ncamera_credentials.json\n';
      fs.writeFileSync(gi, giText, 'utf8');
      console.log('Appended camera_credentials.json to .gitignore');
    }
  } catch (e) { console.error('Failed to update .gitignore:', e.message); }
  console.log('\nYou can now start the server and it will load credentials from camera_credentials.json');
} else {
  console.log('\nSuggested environment variable exports (bash):');
  found.forEach(e => {
    console.log(`# Camera ${e.id}`);
    console.log(`export CAMERA_${e.id}_AUTH='${e.auth}'`);
    console.log(`export CAMERA_${e.id}_USER='${e.user}'`);
    console.log(`export CAMERA_${e.id}_PASSWORD='${e.pass}'`);
    console.log('');
  });
  console.log('To write these into a secrets file instead, re-run this script with --write-secrets and optionally provide the original config backup as the first argument:');
  console.log('  node scripts/scrub_camera_creds.js config.json.bak --write-secrets');
}
