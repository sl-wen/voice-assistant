/**
 * Voice Assistant Server v0.4 - Bidirectional
 * 
 * Direction 1: Phone Mic -> PC (already working)
 * Direction 2: PC Audio -> Phone Speaker
 * 
 * PC audio capture strategy (Windows):
 *   1. ffmpeg recording from Windows audio device (wasapi)
 *   2. If no ffmpeg: skip direction 2
 */

const express = require('express');
const http = require('http'); // fallback only
const https = require('https');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode-terminal');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const SAMPLE_RATE = 48000;
const CHANNELS = 1;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ========== Audio Output (Phone -> PC) ==========
let outputFfmpeg = null;
let wavStream = null;
let wavPath = null;
let bytesReceived = 0;
let useFfmpegOut = false;

function initAudioOutput() {
  try {
    const test = spawn('ffmpeg', ['-version']);
    test.on('error', () => { initFileOutput(); });
    test.on('close', (code) => {
      if (code === 0) { initFfmpegOutput(); } else { initFileOutput(); }
    });
  } catch (e) { initFileOutput(); }
}

function initFfmpegOutput() {
  // Try PowerShell audio bridge first (zero dependency)
  if (process.platform === 'win32') {
    tryPSAudioBridge();
    return;
  }
  // Fallback to ffmpeg for non-Windows
  const args = ['-f','s16le','-ar',String(SAMPLE_RATE),'-ac',String(CHANNELS),'-i','pipe:0','-f','waveaudio','0'];
  try {
    outputFfmpeg = spawn('ffmpeg', args);
    outputFfmpeg.stdin.on('error', () => {});
    outputFfmpeg.stderr.on('data', () => {});
    outputFfmpeg.on('close', () => { if (!wavStream) initFileOutput(); });
    useFfmpegOut = true;
    console.log('[OUT] Audio -> ffmpeg -> default device');
  } catch (e) { initFileOutput(); }
}

function tryPSAudioBridge() {
  const psPath = path.join(__dirname, 'native', 'AudioBridge.ps1');
  if (!fs.existsSync(psPath)) {
    console.log('[OUT] AudioBridge.ps1 not found, fallback to file');
    initFileOutput();
    return;
  }
  try {
    outputFfmpeg = spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-NoProfile',
      '-File', psPath,
      '-Mode', 'Play'
    ]);
    outputFfmpeg.stdin.on('error', () => {});
    outputFfmpeg.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.log('[PS] ' + s);
    });
    outputFfmpeg.on('close', (code) => {
      useFfmpegOut = false;
      if (!wavStream) initFileOutput();
    });
    useFfmpegOut = true;
    console.log('[OUT] Audio -> PowerShell AudioBridge -> speaker');
  } catch (e) {
    console.log('[OUT] PowerShell bridge failed: ' + e.message);
    initFileOutput();
  }
}

function initFileOutput() {
  const dir = path.join(__dirname, 'output');
  fs.mkdirSync(dir, { recursive: true });
  wavPath = path.join(dir, `recording_${Date.now()}.wav`);
  wavStream = fs.createWriteStream(wavPath);
  wavStream.write(Buffer.alloc(44));
  console.log('[OUT] Saving to: ' + wavPath);
}

function writePCMAudio(data) {
  bytesReceived += data.length;
  if (useFfmpegOut && outputFfmpeg && outputFfmpeg.stdin.writable) {
    outputFfmpeg.stdin.write(data);
  } else if (wavStream) {
    wavStream.write(data);
  }
}

function finalizeWav() {
  if (wavStream && wavPath) {
    const fd = fs.openSync(wavPath, 'r+');
    const h = Buffer.alloc(44);
    h.write('RIFF',0); h.writeUInt32LE(36+bytesReceived,4); h.write('WAVE',8);
    h.write('fmt ',12); h.writeUInt32LE(16,16); h.writeUInt16LE(1,20);
    h.writeUInt16LE(CHANNELS,22); h.writeUInt32LE(SAMPLE_RATE,24);
    h.writeUInt32LE(SAMPLE_RATE*CHANNELS*2,28); h.writeUInt16LE(CHANNELS*2,32);
    h.writeUInt16LE(16,34); h.write('data',36); h.writeUInt32LE(bytesReceived,40);
    fs.writeSync(fd, h, 0, 44, 0);
    fs.closeSync(fd);
    wavStream.end();
  }
}

// ========== Audio Input (PC -> Phone) ==========
let captureProcess = null;
let capturing = false;

function startPCAudioCapture(broadcastFn) {
  // Use ffmpeg to capture Windows audio via WASAPI (loopback)
  // This captures whatever is playing on the PC speakers
  const args = [
    '-f', 'dshow',           // DirectShow (Windows)
    '-i', 'audio=Stereo Mix (Realtek(R) Audio)',  // Try stereo mix first
    '-f', 's16le',
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
    'pipe:1'                  // Output raw PCM to stdout
  ];

  // Alternative: WASAPI loopback
  const wasapiArgs = [
    '-f', 'wasapi',
    '-i', 'default',          // Default audio output device (loopback)
    '-f', 's16le',
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
    'pipe:1'
  ];

  console.log('[IN] Starting PC audio capture...');

  // Try WASAPI first (more reliable for capturing system audio)
  tryStartCapture(wasapiArgs, broadcastFn, function() {
    // Fallback: try dshow with stereo mix
    console.log('[IN] WASAPI failed, trying Stereo Mix...');
    tryStartCapture(args, broadcastFn, function() {
      console.log('[IN] No capture method available.');
      console.log('     Install VB-Audio Virtual Cable for system audio capture:');
      console.log('     https://vb-audio.com/Cable/');
      console.log('     Or use ffmpeg with wasapi support.');
    });
  });
}

function tryStartCapture(args, broadcastFn, onFail) {
  try {
    captureProcess = spawn('ffmpeg', args);
    let started = false;

    captureProcess.stderr.on('data', (data) => {
      const str = data.toString();
      if (!started && str.includes('Stream #')) {
        started = true;
        capturing = true;
        console.log('[IN] PC audio capture started');
      }
    });

    captureProcess.stdout.on('data', (data) => {
      if (!capturing) return;
      // Broadcast PCM data to all connected phones
      broadcastFn(data);
    });

    captureProcess.on('close', (code) => {
      capturing = false;
      console.log('[IN] Capture stopped (code: ' + code + ')');
      if (!started && onFail) onFail();
    });

    captureProcess.on('error', (e) => {
      capturing = false;
      if (onFail) onFail();
    });

    // Timeout: if not started in 3s, fail
    setTimeout(() => {
      if (!started && onFail) {
        captureProcess.kill();
        onFail();
      }
    }, 3000);

  } catch (e) {
    if (onFail) onFail();
  }
}

function stopPCAudioCapture() {
  if (captureProcess) {
    captureProcess.kill();
    captureProcess = null;
    capturing = false;
  }
}

// ========== WebSocket Server ==========
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`\n[PHONE] Connected: ${ip} (total: ${wss.clients.size})`);
  bytesReceived = 0;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      writePCMAudio(data);
    } else {
      try {
        const msg = JSON.parse(data.toString());
        switch(msg.type) {
          case 'ping': ws.send(JSON.stringify({ type: 'pong' })); break;
          case 'audio-config': console.log('[AUDIO] config: rate=' + msg.sampleRate); break;
          case 'start-pc-audio':
            console.log('[IN] Phone requested PC audio');
            startPCAudioCapture((pcmData) => {
              if (ws.readyState === 1) ws.send(pcmData);
            });
            break;
          case 'stop-pc-audio':
            console.log('[IN] Phone stopped PC audio');
            stopPCAudioCapture();
            break;
        }
      } catch (e) {}
    }
  });

  ws.on('close', () => {
    console.log(`[PHONE] Disconnected (remaining: ${wss.clients.size})`);
    stopPCAudioCapture();
    if (wss.clients.size === 0 && bytesReceived > 0) {
      finalizeWav();
      const sec = (bytesReceived / (SAMPLE_RATE * 2)).toFixed(1);
      console.log(`[STATS] Recorded ${sec}s`);
    }
  });

  ws.send(JSON.stringify({ type: 'connected' }));
});

// ========== Server (HTTPS only) ==========
let httpsServer = null;
const keyPath = path.join(__dirname, 'key.pem');
const certPath = path.join(__dirname, 'cert.pem');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  httpsServer = https.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  }, app);
} else {
  console.log('[WARN] No cert found, using HTTP (mic may not work on phone)');
  httpsServer = http.createServer(app);
}

httpsServer.listen(PORT, '0.0.0.0', () => {
  httpsServer.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
  });
function getAllIPs() {
  const interfaces = os.networkInterfaces();
  const lanIps = [], otherIps = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const isWSL = name.toLowerCase().includes('veth') ||
                      name.toLowerCase().includes('ws') ||
                      name.toLowerCase().includes('hyper') ||
                      iface.address.startsWith('172.16.') ||
                      iface.address.startsWith('172.20.') ||
                      iface.address.startsWith('172.24.') ||
                      iface.address.startsWith('172.25.');
        if (!isWSL) lanIps.push({ address: iface.address, iface: name });
        else otherIps.push({ address: iface.address, iface: name });
      }
    }
  }
  return { lanIps, otherIps };
}

// ========== Start ==========
  console.log('\n=== Voice Assistant v0.4 (Bidirectional) ===\n');

  const showIps = lanIps.length > 0 ? lanIps : otherIps;
  for (const item of showIps) {
    const url = 'https://' + item.address + ':' + PORT;
    console.log('[' + item.iface + '] ' + item.address);
    console.log('\nScan QR code:\n');
    qrcode.generate(url, { small: true });
    console.log('');
  }

  console.log('='.repeat(40));
  initAudioOutput();
  console.log('\nWaiting for phone connection...\n');
});

process.on('SIGINT', () => {
  console.log('\n\n[STOP]');
  stopPCAudioCapture();
  if (outputFfmpeg) outputFfmpeg.kill();
  finalizeWav();
  if (bytesReceived > 0) console.log('[STATS] Total: ' + (bytesReceived / (SAMPLE_RATE * 2)).toFixed(1) + 's');
  if (wavPath) console.log('[FILE] ' + wavPath);
  if (httpsServer) httpsServer.close();
  process.exit(0);
});
