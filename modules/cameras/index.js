const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

module.exports = function createCameraModule(deps = {}) {
  const router = express.Router();

  // recordings directory lives at project root ./recordings
  const recordingsDir = path.join(__dirname, '..', '..', 'recordings');
  if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

  const ffmpeg = (() => {
    try { return require('fluent-ffmpeg'); } catch (e) { return null; }
  })();

  /*
   * Per-camera health tracking map.
   * Keys are camera IDs and values contain counters and timestamps used to decide
   * when a camera should be temporarily considered "offline" due to repeated
   * ffmpeg/stream errors. Structure example:
   * { errors: Number, lastErrorAt: Number(ms), offlineUntil: Number(ms), lastError: String }
   * This is in-memory only and resets when the server restarts.
   */
  const cameraHealth = {};

  /*
   * Tracks how many active streaming client connections are currently piping
   * data from ffmpeg for each camera. Useful for diagnostics and to avoid
   * starting expensive per-client processes when unnecessary.
   */
  const activeStreams = {};

  /*
   * markCameraError(cameraId, msg)
   * -------------------------------
   * Increment the error counter and record the last error message for a camera.
   * If errors exceed escalation thresholds, mark the camera as temporarily
   * offline by setting `offlineUntil` to a future timestamp. This function is
   * used by multiple ffmpeg callbacks and recording logic to centralize
   * health bookkeeping.
   */
  function markCameraError(cameraId, msg) {
    try {
      const now = Date.now();
      const h = cameraHealth[cameraId] || { errors: 0, lastErrorAt: 0, offlineUntil: 0 };
      if (!h.lastErrorAt || (now - h.lastErrorAt) > 2 * 60 * 1000) h.errors = 0;
      h.errors = (h.errors || 0) + 1;
      h.lastErrorAt = now;
      h.lastError = msg;
      // escalate to offline if repeated errors
      if (h.errors >= 8) {
        h.offlineUntil = now + (60 * 1000); // 60s cooldown
        console.warn(`Camera ${cameraId} marked offline due to repeated errors (errors=${h.errors}) - last: ${msg}`);
      } else {
        console.warn(`Camera ${cameraId} ffmpeg error (errors=${h.errors}): ${msg}`);
      }
      cameraHealth[cameraId] = h;
    } catch (e) {
      console.error('Error updating camera health:', e.message);
    }
  }

  /*
   * ffmpegAvailable: boolean
   * -------------------------
   * Synchronously checks if fluent-ffmpeg is loaded and the `ffmpeg` binary
   * is available on the host system by running `ffmpeg -version`. Used to
   * gate streaming and recording endpoints when the server doesn't have the
   * necessary codec/runtime support.
   */
  const ffmpegAvailable = (() => {
    if (!ffmpeg) return false;
    try {
      const { spawnSync } = require('child_process');
      const out = spawnSync('ffmpeg', ['-version']);
      return out.status === 0;
    } catch (e) { return false; }
  })();

  /*
   * loadRuntimeConfig()
   * --------------------
   * Load camera runtime configuration. Prefer the module-local
   * `modules/cameras/config.json` first, then fall back to the project
   * `config.json` at the repository root, and finally the exported
   * `require('../../config')` module. Returns an object expected to contain
   * a `videoCameras` mapping keyed by camera ID.
   */
  function loadRuntimeConfig() {
    try {
      // Prefer module-local config (modules/cameras/config.json)
      const localCfg = path.join(__dirname, 'config.json');
      if (fs.existsSync(localCfg)) return { videoCameras: JSON.parse(fs.readFileSync(localCfg, 'utf8')) };
    } catch (e) {}
    try {
      const cfgPath = path.join(__dirname, '..', '..', 'config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        // load optional camera credentials file (kept out of git)
        try {
          const credsPath = path.join(__dirname, '..', '..', 'camera_credentials.json');
          if (fs.existsSync(credsPath)) {
            const raw = fs.readFileSync(credsPath, 'utf8');
            cfg._cameraCreds = JSON.parse(raw);
          }
        } catch (e) { /* ignore creds load errors */ }
        // Inject credentials from environment variables when available.
        // Supported env vars per camera ID:
        // - CAMERA_<ID>_AUTH = "user:pass"
        // - CAMERA_<ID>_USER and CAMERA_<ID>_PASSWORD
        // If the URL already contains credentials, we leave it as-is unless
        // env vars are provided to override.
        try {
          if (cfg && cfg.videoCameras) {
            Object.keys(cfg.videoCameras).forEach(id => {
              try {
                const cam = cfg.videoCameras[id];
                if (!cam || !cam.streamUrl) return;
                // parse as URL if possible
                let parsed = null;
                try { parsed = new URL(cam.streamUrl); } catch (e) { parsed = null; }
                // credentials precedence: secrets file -> env var auth -> env user/pass
                const fileCreds = (cfg && cfg._cameraCreds && cfg._cameraCreds[id]) ? cfg._cameraCreds[id] : null;
                const envAuth = process.env[`CAMERA_${id}_AUTH`];
                const envUser = process.env[`CAMERA_${id}_USER`];
                const envPass = process.env[`CAMERA_${id}_PASSWORD`];
                const fileAuth = fileCreds && (fileCreds.auth || (fileCreds.user && fileCreds.password)) ? (fileCreds.auth || `${fileCreds.user}:${fileCreds.password}`) : null;
                const finalAuth = fileAuth || envAuth || ((envUser && envPass) ? `${envUser}:${envPass}` : null);
                if (finalAuth) {
                  const creds = finalAuth;
                  const userPart = creds.split(':')[0] || '';
                  const passPart = creds.split(':')[1] || '';
                  if (parsed) {
                    // For HTTP/FLV endpoints the camera may expect credentials as
                    // query params (user/password), or alternatively as URL
                    // username/password. Support both: if the existing URL has
                    // query params `user`/`password` update them; otherwise set
                    // username/password on the URL object.
                    const hasUserQ = parsed.searchParams.has('user') || parsed.searchParams.has('username');
                    const hasPassQ = parsed.searchParams.has('password');
                    if (hasUserQ || hasPassQ || /^https?:$/i.test(parsed.protocol)) {
                      // prefer query params for HTTP-based camera endpoints
                      if (userPart) parsed.searchParams.set('user', userPart);
                      if (passPart) parsed.searchParams.set('password', passPart);
                      cam.streamUrl = parsed.toString();
                    } else {
                      // fallback to embedding credentials in URL authority
                      parsed.username = userPart;
                      parsed.password = passPart;
                      cam.streamUrl = parsed.toString();
                    }
                  } else {
                    // Not a fully-parseable URL: try to inject as query params or basic creds
                    if (/^[a-z]+:\/\//i.test(cam.streamUrl)) {
                      // append credentials as query params if there's a ? already
                      if (cam.streamUrl.indexOf('?') >= 0) {
                        cam.streamUrl = cam.streamUrl + `&user=${encodeURIComponent(userPart)}&password=${encodeURIComponent(passPart)}`;
                      } else {
                        cam.streamUrl = cam.streamUrl + `?user=${encodeURIComponent(userPart)}&password=${encodeURIComponent(passPart)}`;
                      }
                    }
                  }
                }
              } catch (e) {
                // swallow per-camera parse errors
              }
            });
          }
        } catch (e) {}
        return cfg;
      }
    } catch (e) {}
  try { return require('../../configLoader'); } catch (e) { return {}; }
  }

  // GET /api/cameras - return camera definitions
  router.get('/api/cameras', (req, res) => {
    const cfg = loadRuntimeConfig();
    res.json(cfg.videoCameras || {});
  });

  // Admin health endpoint - returns camera health, active streams and recording status
  router.get('/api/admin/health', (req, res) => {
    try {
      const cfg = loadRuntimeConfig();
      const cams = cfg.videoCameras || {};
      const list = {};
      Object.keys(cams).forEach(id => {
        const h = cameraHealth[id] || { errors: 0, lastErrorAt: 0, offlineUntil: 0 };
        list[id] = {
          camera: cams[id],
          health: h,
          activeStreams: activeStreams[id] || 0,
          recording: !!recordings[id],
          motionRecording: !!motionRecordings[id]
        };
      });
      res.json({ ok: true, generatedAt: new Date().toISOString(), cameras: list });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Stream proxy /camera/:id/stream
  router.get('/camera/:id/stream', (req, res) => {
    const cameraId = req.params.id;
    const cfg = loadRuntimeConfig();
    const camera = cfg.videoCameras && cfg.videoCameras[cameraId];
    if (!camera) return res.status(404).send('Camera not found');

    const streamUrl = camera.streamUrl || '';
    const isHttpStream = /^https?:\/\//i.test(streamUrl);
    const type = (camera.type || '').toLowerCase();
    const wantsFlv = type === 'flv' || /\/flv/i.test(streamUrl);
    const wantsMjpeg = type === 'mjpeg';

    // HTTP-FLV proxy path: many Reolink cameras expose an HTTP-FLV endpoint
    // (e.g. http://host/flv?port=1935&app=... ). If a camera is configured
    // with type 'flv' or the URL contains '/flv', proxy the FLV stream
    // directly (no ffmpeg) and count activeStreams for diagnostics.
    if (isHttpStream && wantsFlv) {
      try {
        // Allow runtime injection of credentials for proxied HTTP streams.
        // Support CAMERA_<ID>_AUTH (user:pass) or CAMERA_<ID>_USER / CAMERA_<ID>_PASSWORD.
        let upstreamUrl = streamUrl;
        try {
          const parsed = new URL(streamUrl);
          const envAuth = process.env[`CAMERA_${cameraId}_AUTH`];
          const envUser = process.env[`CAMERA_${cameraId}_USER`];
          const envPass = process.env[`CAMERA_${cameraId}_PASSWORD`];
          if (envAuth || (envUser && envPass)) {
            const creds = envAuth ? envAuth : `${envUser}:${envPass}`;
            const user = creds.split(':')[0] || '';
            const pass = creds.split(':')[1] || '';
            // Prefer query params (many Reolink/FLV endpoints use user/password query params)
            parsed.searchParams.set('user', user);
            parsed.searchParams.set('password', pass);
            upstreamUrl = parsed.toString();
          }
        } catch (e) {
          // If URL parsing fails, fall back to original streamUrl
          upstreamUrl = streamUrl;
        }
        const upstream = upstreamUrl.startsWith('https://') ? https.get(upstreamUrl) : http.get(upstreamUrl);
        let upstreamRes = null;
        upstream.on('response', (upRes) => {
          upstreamRes = upRes;
          const contentType = upRes.headers['content-type'] || 'video/x-flv';
          res.writeHead(200, { 'Content-Type': contentType });
          // Mark active stream
          activeStreams[cameraId] = (activeStreams[cameraId] || 0) + 1;
          upRes.pipe(res);
        });
        upstream.on('error', (err) => {
          console.error(`Upstream HTTP-FLV stream error for camera ${cameraId}:`, err.message);
          if (!res.headersSent) res.status(502).send('Failed to fetch upstream camera stream');
        });
        req.on('close', () => {
          try { upstream.abort && upstream.abort(); } catch (e) {}
          try { if (activeStreams[cameraId]) activeStreams[cameraId] = Math.max(0, activeStreams[cameraId] - 1); } catch (e) {}
          try { if (upstreamRes && typeof upstreamRes.destroy === 'function') upstreamRes.destroy(); } catch (e) {}
        });
        return;
      } catch (err) {
        console.error(`Failed to proxy HTTP-FLV stream for camera ${cameraId}:`, err.message);
      }
    }

    // HTTP MJPEG proxy (legacy): used when camera.type === 'mjpeg' and streamUrl is http(s)
    if (isHttpStream && wantsMjpeg) {
      try {
        // Inject runtime credentials into the upstream URL if provided via env vars
        let upstreamUrl = streamUrl;
        try {
          const parsed = new URL(streamUrl);
          const envAuth = process.env[`CAMERA_${cameraId}_AUTH`];
          const envUser = process.env[`CAMERA_${cameraId}_USER`];
          const envPass = process.env[`CAMERA_${cameraId}_PASSWORD`];
          if (envAuth || (envUser && envPass)) {
            const creds = envAuth ? envAuth : `${envUser}:${envPass}`;
            const user = creds.split(':')[0] || '';
            const pass = creds.split(':')[1] || '';
            parsed.searchParams.set('user', user);
            parsed.searchParams.set('password', pass);
            upstreamUrl = parsed.toString();
          }
        } catch (e) { upstreamUrl = streamUrl; }
        const upstream = upstreamUrl.startsWith('https://') ? https.get(upstreamUrl) : http.get(upstreamUrl);
        upstream.on('response', (upRes) => {
          const contentType = upRes.headers['content-type'] || 'multipart/x-mixed-replace; boundary=frame';
          res.writeHead(200, { 'Content-Type': contentType });
          upRes.pipe(res);
        });
        upstream.on('error', (err) => {
          console.error(`Upstream HTTP stream error for camera ${cameraId}:`, err.message);
          if (!res.headersSent) res.status(502).send('Failed to fetch upstream camera stream');
        });
        req.on('close', () => { try { upstream.abort && upstream.abort(); } catch (e) {} });
        return;
      } catch (err) {
        console.error(`Failed to proxy HTTP stream for camera ${cameraId}:`, err.message);
      }
    }

    if (!ffmpeg || !ffmpegAvailable) {
      console.error('Cannot stream camera: ffmpeg not available');
      return res.status(501).send('Streaming unavailable: server missing ffmpeg support');
    }

    // Protect against failing cameras: if we have seen many errors recently, back off
    const health = cameraHealth[cameraId] || { errors: 0, lastErrorAt: 0, offlineUntil: 0 };
    const now = Date.now();
    if (health.offlineUntil && now < health.offlineUntil) {
      console.warn(`Camera ${cameraId} is temporarily offline until ${new Date(health.offlineUntil).toISOString()}`);
      return res.status(503).send('Camera temporarily unavailable');
    }

    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');

    // Improved RTSP input options for lower latency and more stable TCP transport
    const inputOptionsBase = [
      '-rtsp_transport', 'tcp',
      '-rtsp_flags', 'prefer_tcp',
      // note: '-stimeout' is unsupported in some ffmpeg builds and causes
      // "Unrecognized option 'stimeout'" errors. Omit it to maintain
      // compatibility; rely on upstream TCP timeouts instead.
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
  '-probesize', '500000',
  '-analyzeduration', '1000000',
      '-use_wallclock_as_timestamps', '1'
    ];

    // Start/maintain an ffmpeg process for this request and auto-retry a few times on transient failure.
    let attempts = 0;
    const maxAttempts = 3;
    let activeCommand = null;
    let stopped = false;

    function startStreamAttempt() {
      if (stopped) return;
      attempts += 1;
      const inputOptions = inputOptionsBase.slice();
      try {
        const command = ffmpeg()
          .input(camera.streamUrl)
          .inputOptions(inputOptions)
          // Map first video stream explicitly and produce MJPEG for HTTP clients
          .outputOptions(['-map', '0:v:0', '-f', 'mjpeg', '-q:v', '5', '-avoid_negative_ts', 'make_zero', '-fflags', '+genpts'])
          .on('start', cmdline => {
            console.log(`FFmpeg start for camera ${cameraId} (attempt ${attempts}): ${cmdline}`);
            // reset health on successful start
            cameraHealth[cameraId] = { errors: 0, lastErrorAt: 0, offlineUntil: 0 };
            activeStreams[cameraId] = (activeStreams[cameraId] || 0) + 1;
            activeCommand = command;
          })
          .on('stderr', stderrLine => {
            const line = String(stderrLine || '').trim();
            console.log(`FFmpeg stderr [stream ${cameraId}]: ${line}`);
          })
          .on('error', err => {
            console.error(`FFmpeg error for camera ${cameraId} (attempt ${attempts}):`, err && err.message ? err.message : err);
            markCameraError(cameraId, err && err.message ? err.message : String(err));
            try { if (!res.headersSent) res.end(); } catch (e) {}
            // attempt restart for transient failures
            cleanupCommand();
            if (!stopped && attempts < maxAttempts) {
              console.log(`Retrying stream for camera ${cameraId} (next attempt ${attempts + 1}) in 700ms`);
              setTimeout(() => startStreamAttempt(), 700);
            }
          })
          .on('end', () => {
            // ffmpeg ended normally
            cleanupCommand();
          });

        // pipe the output to response
        command.pipe(res, { end: true });

        // track cleanup on client close
        req.on('close', () => {
          stopped = true;
          try { if (activeCommand && typeof activeCommand.kill === 'function') activeCommand.kill('SIGKILL'); } catch (e) {}
          cleanupCommand();
        });

        function cleanupCommand() {
          try {
            if (activeStreams[cameraId]) activeStreams[cameraId] = Math.max(0, activeStreams[cameraId] - 1);
          } catch (e) {}
          activeCommand = null;
        }

      } catch (err) {
        console.error(`Failed to start ffmpeg for camera ${cameraId}:`, err.message || err);
        markCameraError(cameraId, err.message || String(err));
        if (attempts < maxAttempts && !stopped) setTimeout(() => startStreamAttempt(), 700);
      }
    }

    // initial start
    startStreamAttempt();
  });

  // Recording endpoints
  const recordings = {};
  router.post('/camera/:id/start-recording', (req, res) => {
    const cameraId = req.params.id;
    const cfg = loadRuntimeConfig();
    const camera = cfg.videoCameras && cfg.videoCameras[cameraId];
    if (!camera) return res.status(404).send('Camera not found');
    if (recordings[cameraId]) return res.status(400).send('Recording already in progress');
  if (!ffmpeg || !ffmpegAvailable) return res.status(501).send('Recording unavailable: server missing ffmpeg support');
  // Back off if camera marked offline due to errors
  const health = cameraHealth[cameraId] || { offlineUntil: 0 };
  if (health.offlineUntil && Date.now() < health.offlineUntil) return res.status(503).send('Camera temporarily unavailable');
    const outputPath = path.join(recordingsDir, `${cameraId}_${Date.now()}.mp4`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    // Clear any transient health cooldown so an explicit user/manual recording still attempts to start
    cameraHealth[cameraId] = { errors: 0, lastErrorAt: 0, offlineUntil: 0 };
  // Choose input options depending on stream protocol. RTSP needs transport flags,
  // but HTTP-FLV should not receive RTSP-specific options (they cause ffmpeg errors).
  let inputOptions = [];
  if (typeof camera.streamUrl === 'string' && camera.streamUrl.toLowerCase().startsWith('rtsp://')) {
    inputOptions = ['-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '500000', '-analyzeduration', '1000000'];
  } else {
    // HTTP/FLV or other HTTP streams — no RTSP-specific options
    inputOptions = [];
  }
    const command = ffmpeg()
      .input(camera.streamUrl)
      .inputOptions(inputOptions)
      .output(outputPath)
      .outputOptions(['-c:v copy', '-c:a aac', '-f mp4'])
      .on('start', cmdline => {
        console.log(`Recording start for camera ${cameraId}: ${cmdline}`);
        cameraHealth[cameraId] = { errors: 0, lastErrorAt: 0, offlineUntil: 0 };
      })
      .on('end', () => { console.log(`Recording stopped for camera ${cameraId}`); delete recordings[cameraId]; })
      .on('error', err => { console.error(`Recording error for camera ${cameraId}:`, err.message); markCameraError(cameraId, err.message); delete recordings[cameraId]; });
    recordings[cameraId] = command;
    command.run();
    res.send('Recording started');
  });

  router.post('/camera/:id/stop-recording', (req, res) => {
    const cameraId = req.params.id;
    const command = recordings[cameraId];
    if (!command) return res.status(400).send('No recording in progress');
    command.kill('SIGINT');
    res.send('Recording stopped');
  });

  // Motion webhook
  const motionRecordings = {};
  router.post('/api/camera-event/:id', (req, res) => {
    const cameraId = req.params.id;
    const cfg = loadRuntimeConfig();
    const camera = cfg.videoCameras && cfg.videoCameras[cameraId];
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    const body = req.body || {};
    const event = body.event || body.type || 'motion';
    if (event !== 'motion') return res.status(400).json({ error: 'Unsupported event' });

    // Object detection filtering: check if webhook contains detected objects
    // and filter based on camera's configured object types (human, vehicle, etc.)
    const detectedObjects = body.objects || body.detectedObjects || [];
    if (detectedObjects.length > 0) {
      const allowedObjectTypes = camera.objectTypes || cfg.objectTypesDefault || ['person', 'vehicle'];
      const hasAllowedObject = detectedObjects.some(obj => {
        const objType = (obj.type || obj.class || obj.label || '').toLowerCase();
        return allowedObjectTypes.some(allowed => allowed.toLowerCase() === objType);
      });

      if (!hasAllowedObject) {
        console.log(`Motion event ignored for camera ${cameraId}: no allowed objects detected. Detected: ${detectedObjects.map(o => o.type || o.class).join(', ')}, Allowed: ${allowedObjectTypes.join(', ')}`);
        return res.json({ success: false, message: 'No allowed objects detected', detectedObjects, allowedObjectTypes });
      }
      console.log(`Motion event accepted for camera ${cameraId}: detected allowed objects: ${detectedObjects.map(o => o.type || o.class).join(', ')}`);
    }

    // Global toggle: skip motion-triggered recordings if disabled in runtime config
    const motionEnabled = (typeof cfg.motionRecordingEnabled === 'undefined') ? true : !!cfg.motionRecordingEnabled;
    console.log(`Motion webhook: camera=${cameraId} motionRecordingEnabled=${String(cfg.motionRecordingEnabled)}`);
    if (!motionEnabled) {
      console.log(`Motion event received for camera ${cameraId} but motion recordings are disabled`);
      return res.json({ success: false, message: 'Motion recordings are disabled' });
    }

    // Motion sensitivity: allow per-camera `motionSensitivity` (0-1 or 0-100) or
    // a global `motionSensitivityDefault` in runtime config. If the incoming
    // webhook provides a numeric score/confidence, normalize and compare it to
    // the threshold. If score is below threshold we ignore the trigger.
    const normalizeScore = (v) => {
      const n = Number(v);
      if (Number.isNaN(n)) return null;
      if (n > 1) return Math.min(1, n / 100); // convert 0-100 -> 0-1
      return Math.max(0, Math.min(1, n)); // clamp 0-1
    };

    const rawThreshold = (camera && typeof camera.motionSensitivity !== 'undefined') ? camera.motionSensitivity : cfg.motionSensitivityDefault;
    const threshold = (typeof rawThreshold === 'undefined' || rawThreshold === null) ? 0 : normalizeScore(rawThreshold) || 0;

    // Accept several common score keys from different camera webhook formats
    const scoreRaw = (body.score || body.confidence || body.confidenceScore || body.motionScore || body.level);
    const score = normalizeScore(scoreRaw);
    if (score !== null && typeof threshold === 'number' && score < threshold) {
      console.log(`Motion event ignored for camera ${cameraId}: score=${score} threshold=${threshold}`);
      return res.json({ success: false, message: 'Motion below sensitivity threshold', score, threshold });
    }

    const duration = Number(body.duration || camera.motionRecordDuration || 30);
  if (!ffmpeg || !ffmpegAvailable) return res.status(503).json({ error: 'Server cannot record: ffmpeg unavailable' });
  // Back off if camera is in cooldown due to repeated errors
  const health = cameraHealth[cameraId] || { offlineUntil: 0 };
  if (health.offlineUntil && Date.now() < health.offlineUntil) return res.status(503).json({ error: 'Camera temporarily unavailable' });
    if (motionRecordings[cameraId] && motionRecordings[cameraId].command) {
      clearTimeout(motionRecordings[cameraId].timeout);
      motionRecordings[cameraId].timeout = setTimeout(() => stopMotionRecording(cameraId), duration * 1000);
      return res.json({ success: true, message: 'Recording extended' });
    }
    try {
      const outputPath = path.join(recordingsDir, `${cameraId}_motion_${Date.now()}.mp4`);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  // Choose input options depending on protocol (same logic as above)
  let motionInputOptions = [];
  if (typeof camera.streamUrl === 'string' && camera.streamUrl.toLowerCase().startsWith('rtsp://')) {
    motionInputOptions = ['-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay', '-probesize', '500000', '-analyzeduration', '1000000'];
  } else {
    motionInputOptions = [];
  }
      // Clear transient health so motion triggers can attempt a recording even after a short cooldown
      cameraHealth[cameraId] = { errors: 0, lastErrorAt: 0, offlineUntil: 0 };
      const command = ffmpeg()
        .input(camera.streamUrl)
        .inputOptions(motionInputOptions)
        .output(outputPath)
        .outputOptions(['-c:v libx264', '-preset fast', '-crf 28', '-c:a aac', '-f mp4', '-avoid_negative_ts make_zero', '-fflags +genpts'])
        .on('start', () => console.log(`Motion recording started for camera ${cameraId} -> ${outputPath}`))
        .on('stderr', stderrLine => {
          const line = String(stderrLine || '').trim();
          console.log(`FFmpeg stderr [motion ${cameraId}]: ${line}`);
        })
        .on('end', () => { console.log(`Motion recording finished for camera ${cameraId}`); if (motionRecordings[cameraId]) delete motionRecordings[cameraId]; })
        .on('error', err => { console.error(`Motion recording error for camera ${cameraId}:`, err.message); markCameraError(cameraId, err.message); if (motionRecordings[cameraId]) delete motionRecordings[cameraId]; });
      motionRecordings[cameraId] = { command, timeout: null };
      command.run();
      motionRecordings[cameraId].timeout = setTimeout(() => stopMotionRecording(cameraId), duration * 1000);
      return res.json({ success: true, message: 'Motion recording started' });
    } catch (error) {
      console.error(`Failed to start motion recording for camera ${cameraId}:`, error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  function stopMotionRecording(cameraId) {
    const rec = motionRecordings[cameraId];
    if (!rec) return;
    try { if (rec.command && typeof rec.command.kill === 'function') rec.command.kill('SIGINT'); } catch (e) {}
    clearTimeout(rec.timeout);
    delete motionRecordings[cameraId];
  }

  // POST /camera/:id/stop-motion-recording - allow admin/UI to cancel an in-progress motion recording
  router.post('/camera/:id/stop-motion-recording', (req, res) => {
    const cameraId = req.params.id;
    const rec = motionRecordings[cameraId];
    if (!rec) return res.status(400).send('No motion recording in progress');
    try {
      if (rec.command && typeof rec.command.kill === 'function') rec.command.kill('SIGINT');
    } catch (e) {}
    clearTimeout(rec.timeout);
    delete motionRecordings[cameraId];
    res.send('Motion recording stopped');
  });

  return { router, publicPath: path.join(__dirname, 'public'), manifest: require('./manifest.json') };
};
