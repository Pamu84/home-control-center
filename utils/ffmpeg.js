/*
 * FFmpeg Utilities
 * ----------------
 * Handles FFmpeg availability checking and setup for camera streaming.
 */

let ffmpeg;
let ffmpegAvailable = false;

try {
  ffmpeg = require('fluent-ffmpeg');
} catch (e) {
  console.warn('fluent-ffmpeg module not available:', e.message);
}

// Check that ffmpeg binary is available in PATH
if (ffmpeg) {
  try {
    const { spawnSync } = require('child_process');
    const out = spawnSync('ffmpeg', ['-version']);
    if (out.status === 0) ffmpegAvailable = true;
  } catch (e) {
    ffmpegAvailable = false;
  }
  if (!ffmpegAvailable) console.warn('ffmpeg binary not found in PATH; camera streaming/recording will be unavailable');
}

module.exports = {
  ffmpeg,
  ffmpegAvailable
};