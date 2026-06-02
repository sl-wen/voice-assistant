/**
 * Voice Assistant Server v0.3.1
 */

const express = require('express');
const http = require('http');
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
const server = http.createServer(app);
app.use(express.static(path.join(__dirname, 'public')));

// Try HTTPS on PORT+1
let httpsServer = null;
const HTTPS_PORT = PORT + 1;
try {
  const keyPath = path.join(__dirname, 'key.pem');
  const certPath = path.join(__dirname, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const options = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
    httpsServer = https.createServer(options, app);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log('[HTTPS] Also available on port ' + HTTPS_PORT + ' (self-signed cert)');
    });
    // WebSocket upgrade for HTTPS
    httpsServer.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
  }
} catch(e) {
  // HTTPS not available, HTTP only
}

let ffmpegProcess = null;
let wavStream = null;
let wavPath = null;
let bytesReceived = 0;
let useFfmpeg = false;

function initAudioOutput() {
  try {
    const test = spawn('ffmpeg', ['-version']);
    test.on('error', () => {
      console.log('[INFO] ffmpeg not found, using file output mode');
      console.log('       Install ffmpeg: winget install Gyan.FFmpeg');
      initFileOutput();
    });
    test.on('close', (code) => {
      if (code === 0) {
        console.log('[OK] ffmpeg ready');
        initFFmpegOutput();
      } else {
        initFileOutput();
      }
    });
  } catch (e) {
    initFileOutput();
  }
}

function initFFmpegOutput() {
  const args = [
    '-f', 's16le',
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
    '-i', 'pipe:0',
    '-f', 'waveaudio',
    '0',
  ];
  try {
    ffmpegProcess = spawn('ffmpeg', args);
    ffmpegProcess.stdin.on('error', () => {});
    ffmpegProcess.stderr.on('data', () => {});
    ffmpegProcess.on('close', (code) => {
      if (code !== 0 && !wavStream) {
        console.log('[WARN] ffmpeg failed, fallback to file mode');
        initFileOutput();
      }
    });
    useFfmpeg = true;
    console.log('[OK] Audio -> ffmpeg -> default device');
  } catch (e) {
    initFileOutput();
  }
}

function initFileOutput() {
  const outputDir = path.join(__dirname, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  wavPath = path.join(outputDir, `recording_${Date.now()}.wav`);
  wavStream = fs.createWriteStream(wavPath);
  wavStream.write(Buffer.alloc(44));
  console.log(`[OK] Audio saving to: ${wavPath}`);
  console.log('     Press Ctrl+C to stop and save');
}

function writeAudio(data) {
  bytesReceived += data.length;
  if (useFfmpeg && ffmpegProcess && ffmpegProcess.stdin.writable) {
    ffmpegProcess.stdin.write(data);
  } else if (wavStream) {
    wavStream.write(data);
  }
}

function finalizeWav() {
  if (wavStream && wavPath) {
    const fd = fs.openSync(wavPath, 'r+');
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + bytesReceived, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
    header.writeUInt16LE(CHANNELS * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(bytesReceived, 40);
    fs.writeSync(fd, header, 0, 44, 0);
    fs.closeSync(fd);
    wavStream.end();
  }
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`\n[PHONE] Connected: ${ip} (total: ${wss.clients.size})`);
  bytesReceived = 0;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      writeAudio(data);
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        else if (msg.type === 'audio-config') console.log(`[AUDIO] config: rate=${msg.sampleRate}`);
      } catch (e) {}
    }
  });

  ws.on('close', () => {
    console.log(`[PHONE] Disconnected (remaining: ${wss.clients.size})`);
    if (wss.clients.size === 0 && bytesReceived > 0) {
      finalizeWav();
      const sec = (bytesReceived / (SAMPLE_RATE * 2)).toFixed(1);
      console.log(`[STATS] Recorded ${sec}s (${bytesReceived} bytes)`);
    }
  });

  ws.send(JSON.stringify({ type: 'connected' }));
});

function getAllIPs() {
  const interfaces = os.networkInterfaces();
  const lanIps = [];
  const otherIps = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // Filter out WSL/Hyper-V virtual addresses
        const isWSL = name.toLowerCase().includes('veth') ||
                      name.toLowerCase().includes('ws') ||
                      name.toLowerCase().includes('hyper') ||
                      iface.address.startsWith('172.16.') ||
                      iface.address.startsWith('172.20.') ||
                      iface.address.startsWith('172.24.') ||
                      iface.address.startsWith('172.25.');
        if (!isWSL) {
          lanIps.push({ address: iface.address, iface: name });
        } else {
          otherIps.push({ address: iface.address, iface: name });
        }
      }
    }
  }
  return { lanIps, otherIps };
}

server.listen(PORT, '0.0.0.0', () => {
  const { lanIps, otherIps } = getAllIPs();
  
  console.log('\n=== Voice Assistant ===');
  console.log('Server running on port ' + PORT + '\n');

  // Show all IPs for debugging
  if (lanIps.length === 0 && otherIps.length === 0) {
    console.log('[WARN] No external IP found!');
    console.log('Try: http://localhost:' + PORT);
  }

  // Prefer real LAN IPs
  const showIps = lanIps.length > 0 ? lanIps : otherIps;
  for (const item of showIps) {
    const url = 'http://' + item.address + ':' + PORT;
    const httpsUrl = 'https://' + item.address + ':' + HTTPS_PORT;
    console.log('[' + item.iface + '] ' + item.address);
    console.log('\n[HTTP] ' + url + ' (may not support mic)\n');
    qrcode.generate(url, { small: true });
    console.log('\n[HTTPS] ' + httpsUrl + ' (use this for mic access)\n');
    qrcode.generate(httpsUrl, { small: true });
    console.log('');
  }

  // Also show filtered-out IPs for reference
  if (lanIps.length > 0 && otherIps.length > 0) {
    console.log('(Ignored virtual IPs: ' + otherIps.map(i=>i.address).join(', ') + ')');
    console.log('');
  }

  console.log('='.repeat(30));
  initAudioOutput();
  console.log('\nWaiting for phone connection...\n');
});

process.on('SIGINT', () => {
  console.log('\n\n[STOP] Shutting down...');
  if (ffmpegProcess) ffmpegProcess.kill();
  finalizeWav();
  if (bytesReceived > 0) {
    const sec = (bytesReceived / (SAMPLE_RATE * 2)).toFixed(1);
    console.log(`[STATS] Total: ${sec}s`);
  }
  if (wavPath) console.log(`[FILE] ${wavPath}`);
  server.close();
  process.exit(0);
});
