// Lightweight integration test for /api/camera-event/:id
// Sends motion events with and without object detection data.
// Usage: node scripts/test_motion_webhook.js [cameraId] [baseUrl]

const axios = require('axios');

async function postEvent(baseUrl, cameraId, payload) {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/camera-event/${cameraId}`;
    const r = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
    console.log(`POST ${url} -> ${r.status}`);
    console.log(r.data);
  } catch (err) {
    if (err.response) {
      console.error(`Error ${err.response.status}:`, err.response.data);
    } else {
      console.error('Request failed:', err.message);
    }
  }
}

(async function main(){
  const cameraId = process.argv[2] || '100';
  const baseUrl = process.argv[3] || 'http://localhost:3000';
  console.log('Testing motion webhook for camera', cameraId, 'against', baseUrl);

  console.log('\n1) Sending low-confidence motion (should be ignored if threshold higher)');
  await postEvent(baseUrl, cameraId, { event: 'motion', score: 10, duration: 5 });

  console.log('\n2) Sending high-confidence motion (should trigger recording if enabled)');
  await postEvent(baseUrl, cameraId, { event: 'motion', score: 90, duration: 5 });

  console.log('\n3) Sending motion with person detection (should trigger if person is allowed)');
  await postEvent(baseUrl, cameraId, {
    event: 'motion',
    score: 85,
    duration: 10,
    objects: [{ type: 'person', confidence: 0.92 }]
  });

  console.log('\n4) Sending motion with vehicle detection (should trigger if vehicle is allowed)');
  await postEvent(baseUrl, cameraId, {
    event: 'motion',
    score: 78,
    duration: 15,
    detectedObjects: [{ class: 'vehicle', confidenceScore: 0.88 }]
  });

  console.log('\n5) Sending motion with animal detection (should be ignored if only person/vehicle allowed)');
  await postEvent(baseUrl, cameraId, {
    event: 'motion',
    score: 65,
    duration: 8,
    objects: [{ type: 'animal', label: 'cat', confidence: 0.75 }]
  });

  console.log('\nDone');
})();
