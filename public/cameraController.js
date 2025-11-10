/*
 * Camera UI initializer
 * ---------------------
 * On DOMContentLoaded find camera containers and initialize streams. For
 * RTSP-capable cameras the UI attempts WebRTC via a local MediaMTX relay;
 * otherwise it falls back to the MJPEG proxy endpoint at /camera/:id/stream.
 */
document.addEventListener("DOMContentLoaded", () => {
  // Initialize camera streams
  (async () => {
    let cameras = {};
    try {
      const res = await fetch('/api/cameras');
      if (res.ok) cameras = await res.json();
    } catch (e) {
      console.warn('Failed to fetch camera list, falling back to default elements');
    }

    document.querySelectorAll(".camera-container").forEach(async container => {
      const cameraId = container.getAttribute("data-id");
      const info = cameras[cameraId] || {};
      const type = (info.type || '').toLowerCase();

      // HTTP-FLV: use flv.js in-browser playback when available
      const wantsFlv = type === 'flv' || (info.streamUrl && /\/flv/i.test(info.streamUrl));
      if (wantsFlv && typeof flvjs !== 'undefined' && flvjs.isSupported()) {
        // Ensure a VIDEO element exists in the container
        let video = document.getElementById(`cameraVideo${cameraId}`);
        if (!video) {
          const streamDiv = container.querySelector('.camera-stream');
          if (streamDiv) {
            streamDiv.innerHTML = '';
            video = document.createElement('video');
            video.id = `cameraVideo${cameraId}`;
            video.autoplay = true;
            video.playsInline = true;
            video.muted = true;
            video.controls = true;
            streamDiv.appendChild(video);
          }
        }
        try {
          if (video && !video._flvPlayer) {
            // Fetch audio recording setting
            let audioEnabled = false;
            try {
              const settingsRes = await fetch('/api/settings');
              if (settingsRes.ok) {
                const settings = await settingsRes.json();
                audioEnabled = !!settings.audioRecordingEnabled;
              }
            } catch (e) {
              console.warn('Failed to fetch audio recording setting, defaulting to disabled:', e);
            }

            const url = `/camera/${cameraId}/stream`;
            const player = flvjs.createPlayer({ 
              type: 'flv', 
              url,
              hasAudio: audioEnabled,
              isLive: true,
              // Live stream optimizations to reduce warnings and improve performance
              enableStashBuffer: false,
              autoCleanupSourceBuffer: true,
              autoCleanupMaxBackwardDuration: 30,
              autoCleanupMinBackwardDuration: 10
            });
            player.attachMediaElement(video);
            player.load();
            video._flvPlayer = player;

            // Add error handling
            player.on(flvjs.Events.ERROR, (errorType, errorDetail, errorInfo) => {
              console.error('FLV player error for camera', cameraId, errorType, errorDetail, errorInfo);
              // Optionally retry or show error message
              setTimeout(() => {
                if (player && !player.destroyed) {
                  console.log('Retrying FLV stream for camera', cameraId);
                  player.unload();
                  player.load();
                }
              }, 5000); // Retry after 5 seconds
            });

            player.on(flvjs.Events.LOADING_COMPLETE, () => {
              console.log('FLV loading complete for camera', cameraId);
            });

            // Handle metadata events to suppress duplicate metadata warnings
            player.on(flvjs.Events.METADATA_ARRIVED, (metadata) => {
              // Metadata arrived, handle silently
              console.debug('FLV metadata arrived for camera', cameraId, metadata);
            });

            // Handle script data events (includes onMetaData)
            player.on(flvjs.Events.SCRIPT_DATA_ARRIVED, (data) => {
              // Script data arrived (may include onMetaData), handle silently
              if (data && data.onMetaData) {
                console.debug('FLV onMetaData arrived for camera', cameraId);
              }
            });
          }
        } catch (e) {
          console.error('Failed to initialize flv.js player for', cameraId, e);
        }
        return;
      }

      if (type && type === 'rtsp') {
        // Use WebRTC via MediaMTX (WHEP endpoint)
        startWebRTC(cameraId, info).catch(err => console.error('WebRTC failed for', cameraId, err));
        return;
      }

      // Fallback to MJPEG or generic HTTP proxy
      const streamElement = document.getElementById(`cameraStream${cameraId}`);
      if (streamElement) streamElement.src = `/camera/${cameraId}/stream`;
    });
    // load recordings list
    try { await loadRecordings(); } catch (e) { console.warn('Failed to load recordings', e); }
  })();
});

/*
 * loadRecordings()
 * ----------------
 * Fetch the list of recorded MP4 files and render entries with a video
 * player and delete action. Used by the recordings UI pane.
 */
async function loadRecordings() {
  const root = document.getElementById('recordingsRoot');
  if (!root) return;
  root.innerHTML = 'Loading recordings...';
  try {
    const res = await fetch('/api/recordings');
    if (!res.ok) throw new Error('Failed to fetch recordings');
    const list = await res.json();
    if (!list.length) {
      root.innerHTML = '<em>No recordings found</em>';
      return;
    }
    root.innerHTML = '';
    list.forEach(item => {
      const el = document.createElement('div');
      el.className = 'recording-item';
      el.style.borderTop = '1px solid #eee';
      el.style.paddingTop = '10px';
      el.style.marginTop = '10px';

      const info = document.createElement('div');
      info.innerHTML = `<strong>Camera:</strong> ${item.cameraId || '-'} &nbsp; <strong>Time:</strong> ${item.mtime} &nbsp; <strong>Size:</strong> ${Math.round(item.size/1024)} KB`;

      const vid = document.createElement('video');
      vid.src = item.url;
      vid.controls = true;
      vid.width = 360;
      vid.style.display = 'block';
      vid.style.marginTop = '8px';

      const actions = document.createElement('div');
      actions.style.marginTop = '6px';
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.onclick = async () => {
        if (!confirm('Delete this recording?')) return;
        try {
          const dres = await fetch(`/api/recordings/${encodeURIComponent(item.filename)}`, { method: 'DELETE' });
          if (!dres.ok) throw new Error(await dres.text());
          el.remove();
        } catch (err) { alert('Delete failed: ' + err.message); }
      };
      actions.appendChild(del);

      el.appendChild(info);
      el.appendChild(vid);
      el.appendChild(actions);
      root.appendChild(el);
    });
  } catch (err) {
    root.innerHTML = `<span style="color:red">Error: ${err.message}</span>`;
  }
}

/*
 * toggleCamera(cameraId)
 * ----------------------
 * Toggle playback for a camera. Supports both MJPEG (<img>) and WebRTC
 * (<video>) elements. For WebRTC it tears down or creates a PeerConnection
 * via `startWebRTC` as required.
 */
async function toggleCamera(cameraId) {
  // Support both MJPEG <img id="cameraStream{ID}"> and WebRTC <video id="cameraVideo{ID}">
  const img = document.getElementById(`cameraStream${cameraId}`);
  const video = document.getElementById(`cameraVideo${cameraId}`);

  if (video) {
    try {
      // If a pc exists, srcObject set, or an flv.js player is active, stop the playback
      if (video._pc || video.srcObject || video._flvPlayer) {
        console.log(`Toggling off video stream for ${cameraId}`);
        try { if (video._pc) video._pc.close(); } catch (e) { console.warn(e); }
        video._pc = null;
        try { video.srcObject = null; } catch (e) {}
        // If flv.js player attached, unload and destroy it
        try {
          if (video._flvPlayer) {
            try { video._flvPlayer.unload(); } catch (e) {}
            try { video._flvPlayer.detachMediaElement(); } catch (e) {}
            try { video._flvPlayer.destroy(); } catch (e) {}
            video._flvPlayer = null;
          }
        } catch (e) { console.warn('Error tearing down flv player', e); }
        video.removeAttribute('src');
        try { video.load(); } catch (e) {}
        return;
      }
      // otherwise start WebRTC for RTSP cameras
      console.log(`Toggling on video stream for ${cameraId}`);
      const res = await fetch('/api/cameras');
      const cams = res.ok ? await res.json() : {};
      const info = cams[cameraId] || {};
      const type = (info.type || '').toLowerCase();
      if (type === 'rtsp') {
        await startWebRTC(cameraId, info);
      } else if (type === 'flv' && typeof flvjs !== 'undefined' && flvjs.isSupported()) {
        // Initialize flv.js player on demand
        try {
          if (!video._flvPlayer) {
            // Fetch audio recording setting
            let audioEnabled = false;
            try {
              const settingsRes = await fetch('/api/settings');
              if (settingsRes.ok) {
                const settings = await settingsRes.json();
                audioEnabled = !!settings.audioRecordingEnabled;
              }
            } catch (e) {
              console.warn('Failed to fetch audio recording setting, defaulting to disabled:', e);
            }

            const url = `/camera/${cameraId}/stream`;
            const player = flvjs.createPlayer({ 
              type: 'flv', 
              url,
              hasAudio: audioEnabled,
              isLive: true,
              // Live stream optimizations to reduce warnings and improve performance
              enableStashBuffer: false,
              autoCleanupSourceBuffer: true,
              autoCleanupMaxBackwardDuration: 30,
              autoCleanupMinBackwardDuration: 10
            });
            player.attachMediaElement(video);
            player.load();
            video._flvPlayer = player;
          }
        } catch (e) { console.error('Failed to start flv.js player', e); }
      } else {
        console.warn('No RTSP/FLV info for camera', cameraId);
      }
    } catch (err) {
      console.error('toggleCamera video error', err);
    }
    return;
  }

  if (img) {
    // MJPEG img toggle
    try {
      if (img.src) img.src = "";
      else img.src = `/camera/${cameraId}/stream`;
    } catch (err) {
      console.error('toggleCamera img error', err);
    }
  }
}

/*
 * refreshCamera(cameraId)
 * ------------------------
 * Force a reload of a camera stream by clearing the element's source and
 * reinitializing the stream. For WebRTC this closes the PeerConnection and
 * re-runs `startWebRTC`.
 */
function refreshCamera(cameraId) {
  const streamElement = document.getElementById(`cameraStream${cameraId}`) || document.getElementById(`cameraVideo${cameraId}`);
  if (!streamElement) return;
  if (streamElement.tagName === 'IMG') {
    const src = streamElement.src;
    streamElement.src = "";
    setTimeout(() => { streamElement.src = src; }, 100);
  } else if (streamElement.tagName === 'VIDEO') {
    // reload WebRTC by tearing down and restarting
    if (streamElement._pc) {
      try { streamElement._pc.close(); } catch (e) {}
      streamElement._pc = null;
    }
    // If a flv.js player is attached, destroy and recreate it
    if (streamElement._flvPlayer) {
      try { streamElement._flvPlayer.unload(); } catch (e) {}
      try { streamElement._flvPlayer.detachMediaElement(); } catch (e) {}
      try { streamElement._flvPlayer.destroy(); } catch (e) {}
      streamElement._flvPlayer = null;
    }
    // Re-init via DOMContentLoaded logic: call startWebRTC or re-create flv player
    (async () => {
      try {
        const res = await fetch('/api/cameras');
        const cams = res.ok ? await res.json() : {};
        const info = cams[cameraId] || {};
        const type = (info.type || '').toLowerCase();
        if (type && type === 'rtsp') await startWebRTC(cameraId, info);
        else if (type === 'flv' && typeof flvjs !== 'undefined' && flvjs.isSupported()) {
          // Fetch audio recording setting
          let audioEnabled = false;
          try {
            const settingsRes = await fetch('/api/settings');
            if (settingsRes.ok) {
              const settings = await settingsRes.json();
              audioEnabled = !!settings.audioRecordingEnabled;
            }
          } catch (e) {
            console.warn('Failed to fetch audio recording setting, defaulting to disabled:', e);
          }

          const url = `/camera/${cameraId}/stream`;
          const player = flvjs.createPlayer({ 
            type: 'flv', 
            url,
            hasAudio: audioEnabled,
            isLive: true,
            // Live stream optimizations to reduce warnings and improve performance
            enableStashBuffer: false,
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 30,
            autoCleanupMinBackwardDuration: 10
          });
          player.attachMediaElement(streamElement);
          player.load();
          streamElement._flvPlayer = player;
        }
      } catch (e) { console.error(e); }
    })();
  }
}

/*
 * startRecording(cameraId)
 * ------------------------
 * Trigger the server to start recording a camera's stream to disk. Alerts
 * the user on success/failure.
 */
async function startRecording(cameraId) {
  try {
    const response = await fetch(`/camera/${cameraId}/start-recording`, { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
    alert('Recording started');
  } catch (error) {
    alert(`Failed to start recording: ${error.message}`);
  }
}

/*
 * stopRecording(cameraId)
 * -----------------------
 * Signal the server to stop an in-progress recording for the camera.
 */
async function stopRecording(cameraId) {
  try {
    const response = await fetch(`/camera/${cameraId}/stop-recording`, { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
    alert('Recording stopped');
  } catch (error) {
    alert(`Failed to stop recording: ${error.message}`);
  }
}

/*
 * startWebRTC(cameraId, info)
 * ----------------------------
 * Establish a WebRTC playback session for the camera using a local
 * MediaMTX WHEP endpoint. Creates an RTCPeerConnection, posts an SDP
 * offer to MediaMTX and applies the answer. Ensures graceful handling of
 * autoplay/AbortError conditions.
 */
async function startWebRTC(cameraId, info) {
  const video = document.getElementById(`cameraVideo${cameraId}`);
  if (!video) throw new Error('Video element not found');

  /*
   * safePlay(videoElement)
   * -----------------------
   * Attempt to `play()` a HTMLVideoElement while treating AbortError as
   * non-fatal (it commonly occurs during rapid toggles). Other errors are
   * propagated for debugging.
   */
  function safePlay(v) {
    return v.play().catch(err => {
      // AbortError happens when a new load/seek starts before previous play() resolved.
      // It's safe to ignore in our toggle/refresh flows.
      if (err && err.name === 'AbortError') return;
      // Other errors should be surfaced for debugging
      throw err;
    });
  }

  const pc = new RTCPeerConnection();
  video._pc = pc;
  // Ensure video element can autoplay
  try { video.muted = true; } catch (e) {}
  video.autoplay = true;
  video.playsInline = true;

  pc.ontrack = (ev) => {
    console.log('ontrack event, streams:', ev.streams);
    // Avoid interrupting an ongoing load: only replace srcObject if it changed.
    try {
      if (video.srcObject !== ev.streams[0]) {
        // Pause first to avoid conflicting load/play cycles
        try { video.pause(); } catch (e) {}
        video.srcObject = ev.streams[0];
      }
      // Attempt to play; ignore AbortError caused by rapid toggles
      safePlay(video).catch(e => console.warn('video.play() failed:', e));
    } catch (e) {
      console.warn('ontrack handler error:', e);
    }
  };

  pc.onicecandidate = (e) => { console.log('PC icecandidate:', e.candidate); };
  pc.oniceconnectionstatechange = () => { console.log('PC iceConnectionState:', pc.iceConnectionState); };
  pc.onconnectionstatechange = () => { console.log('PC connectionState:', pc.connectionState); };

  // Add transceivers for recvonly to ensure server sends media
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // Wait for ICE gathering to complete (so offer includes ufrag/pwd and candidates)
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    function checkState() {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }
    }
    pc.addEventListener('icegatheringstatechange', checkState);
    // fallback timeout in case gathering stalls
    setTimeout(() => { pc.removeEventListener('icegatheringstatechange', checkState); resolve(); }, 2500);
  });

  // Post SDP to MediaMTX WHEP endpoint (matches mediamtx.yml webrtcAddress :8889)
  // Post directly to MediaMTX WHEP endpoint so MediaMTX sees the real client IP (required for ICE)
  const host = window.location.hostname;
  const path = `camera${cameraId}`;
  const url = `${window.location.protocol}//${host}:8889/${path}/whep`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription.sdp
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`WHEP failed: ${res.status} ${txt}`);
  }
  const answer = await res.text();
  console.log('Received SDP answer length:', answer.length);
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  // ensure playback is attempted after remote description
  safePlay(video).catch(e => console.warn('video.play() after setRemoteDescription failed:', e));
  // if connection doesn't become ready within 8s, log a warning
  setTimeout(() => {
    if (pc.connectionState !== 'connected' && pc.iceConnectionState !== 'connected') {
      console.warn('WebRTC session not connected after 8s, states:', pc.connectionState, pc.iceConnectionState);
    }
  }, 8000);
}