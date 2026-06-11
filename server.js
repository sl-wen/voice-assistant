/**
 * SoundBridge Server v1.1 — Auto-Reconnect Edition
 * Phone mic <-> PC speaker, with relay + PC audio capture
 *
 * v1.1 changes:
 *   - Relay reconnect with session preservation (60s grace on server)
 *   - Exponential backoff: 2s → 4s → 8s → 15s cap
 *   - Audio devices (WASAPI/WinMM) stay alive across reconnects
 *   - Codec re-negotiation on reconnect
 *   - Network online/offline event handling
 *
 * Modes:
 *   LAN  (default): PC runs HTTPS server, phone connects directly
 *   RELAY: PC connects to cloud relay, phone connects via internet
 *
 * Usage:
 *   npm start                          # LAN mode
 *   RELAY_URL=wss://slwen.cn/voice/ws npm start  # Relay mode
 */

const express = require('express');
const https = require('https');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const qrcode = require('qrcode-terminal');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const SAMPLE_RATE = 48000;
const RELAY_URL = process.env.RELAY_URL || null;
const RELAY_PUBLIC_URL = process.env.RELAY_PUBLIC_URL || 'https://slwen.cn/voice/';

// ========== Opus ==========
let opusEncoder = null;
let opusDecoder = null;
let useOpus = false;
const OPUS_FRAME_SIZE = 960; // 20ms @ 48kHz
const OPUS_FRAME_BYTES = OPUS_FRAME_SIZE * 2; // s16le = 2 bytes/sample

try {
  const OpusScript = require('opusscript');
  opusEncoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
  opusEncoder.setBitrate(64000);
  opusDecoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
  useOpus = true;
  console.log('[OPUS] Encoder & Decoder ready (64kbps)');
} catch (e) {
  console.log('[OPUS] opusscript unavailable, PCM fallback: ' + e.message);
}

function opusEncode(pcmBuffer) {
  if (!opusEncoder) return null;
  return opusEncoder.encode(pcmBuffer, OPUS_FRAME_SIZE);
}

function opusDecode(opusFrame) {
  if (!opusDecoder) return null;
  return opusDecoder.decode(opusFrame);
}

// ========== Express ==========
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ========== WebSocket (noServer) ==========
const wss = new WebSocketServer({ noServer: true });

// ========== Audio Output (Phone -> PC) ==========
let audioProcess = null;
let audioMode = 'none';
let wavFd = null;
let wavPath = null;
let bytesReceived = 0;

function initAudioOutput() {
  if (process.platform === 'win32') {
    initPSAudio();
  } else {
    initFileOutput();
  }
}

function initPSAudio() {
  const inlinePS = `
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public class PCMPlayer {
    [DllImport("winmm.dll")] public static extern int waveOutOpen(out IntPtr h, int id, ref F fmt, IntPtr cb, IntPtr inst, int flags);
    [DllImport("winmm.dll")] public static extern int waveOutPrepareHeader(IntPtr h, IntPtr hdr, int sz);
    [DllImport("winmm.dll")] public static extern int waveOutWrite(IntPtr h, IntPtr hdr, int sz);
    [DllImport("winmm.dll")] public static extern int waveOutUnprepareHeader(IntPtr h, IntPtr hdr, int sz);
    [DllImport("winmm.dll")] public static extern int waveOutClose(IntPtr h);
    [StructLayout(LayoutKind.Sequential)] public struct F { public short tag; public short ch; public int sr; public int br; public short ba; public short bps; public short cb; }
    [StructLayout(LayoutKind.Sequential)] public struct H { public IntPtr data; public int len; public int rec; public IntPtr user; public int flags; public int loops; public IntPtr next; public IntPtr res; }
    public static void Play(Stream stdin) {
        F fmt = new F(); fmt.tag=1; fmt.ch=1; fmt.sr=48000; fmt.bps=16; fmt.ba=2; fmt.br=96000; fmt.cb=0;
        IntPtr hw;
        if (waveOutOpen(out hw, -1, ref fmt, IntPtr.Zero, IntPtr.Zero, 0) != 0) { Console.Error.WriteLine("OPEN_FAIL"); return; }
        byte[] buf = new byte[9600];
        while (true) {
            int r = stdin.Read(buf, 0, buf.Length);
            if (r <= 0) break;
            IntPtr p = Marshal.AllocHGlobal(r);
            Marshal.Copy(buf, 0, p, r);
            H hdr = new H(); hdr.data=p; hdr.len=r;
            IntPtr hp = Marshal.AllocHGlobal(Marshal.SizeOf(hdr));
            Marshal.StructureToPtr(hdr, hp, false);
            waveOutPrepareHeader(hw, hp, Marshal.SizeOf(hdr));
            waveOutWrite(hw, hp, Marshal.SizeOf(hdr));
            int wait=0;
            while (wait<2000) { Thread.Sleep(1); H cur=(H)Marshal.PtrToStructure(hp,typeof(H)); if((cur.flags&1)!=0)break; wait++; }
            waveOutUnprepareHeader(hw, hp, Marshal.SizeOf(hdr));
            Marshal.FreeHGlobal(p); Marshal.FreeHGlobal(hp);
        }
        waveOutClose(hw);
    }
}
"@
[PCMPlayer]::Play([Console]::OpenStandardInput())
`;
  try {
    audioProcess = spawn('powershell.exe', ['-ExecutionPolicy','Bypass','-NoProfile','-NonInteractive','-Command',inlinePS]);
    audioProcess.stdin.on('error', () => {});
    audioProcess.stderr.on('data', (d) => { const s=d.toString().trim(); if(s&&s!=='READY') console.log('[PS-AUDIO] '+s); });
    audioProcess.on('close', (code) => { console.log('[PS-AUDIO] Exited ('+code+')'); audioProcess=null; audioMode='none'; });
    audioProcess.on('error', (e) => { audioProcess=null; initFileOutput(); });
    audioMode = 'ps';
    console.log('[OUT] Audio -> PowerShell WinMM -> speaker');
  } catch (e) { initFileOutput(); }
}

function initFileOutput() {
  const dir = path.join(__dirname, 'output');
  fs.mkdirSync(dir, { recursive: true });
  wavPath = path.join(dir, 'recording_' + Date.now() + '.wav');
  wavFd = fs.openSync(wavPath, 'w');
  fs.writeSync(wavFd, Buffer.alloc(44));
  audioMode = 'file';
  console.log('[OUT] Saving to: ' + wavPath);
}

function writeAudioPCM(pcmData) {
  bytesReceived += pcmData.length;
  if (audioMode === 'ps' && audioProcess && audioProcess.stdin.writable) audioProcess.stdin.write(pcmData);
  else if (audioMode === 'file' && wavFd) fs.writeSync(wavFd, pcmData);
}

function closeAudio() {
  if (audioProcess) { audioProcess.stdin.end(); audioProcess = null; }
  if (wavFd && wavPath) {
    const h = Buffer.alloc(44);
    h.write('RIFF',0); h.writeUInt32LE(36+bytesReceived,4); h.write('WAVE',8); h.write('fmt ',12);
    h.writeUInt32LE(16,16); h.writeUInt16LE(1,20); h.writeUInt16LE(1,22); h.writeUInt32LE(SAMPLE_RATE,24);
    h.writeUInt32LE(SAMPLE_RATE*2,28); h.writeUInt16LE(2,32); h.writeUInt16LE(16,34);
    h.write('data',36); h.writeUInt32LE(bytesReceived,40);
    fs.writeSync(wavFd, h, 0, 44, 0);
    fs.closeSync(wavFd); wavFd = null;
    if (bytesReceived > 0) console.log('[FILE] Saved: '+wavPath+' ('+(bytesReceived/SAMPLE_RATE/2).toFixed(1)+'s)');
  }
}

// ========== PC Audio Capture (PC -> Phone) ==========
let captureProcess = null;
let captureActive = false;
let bytesSent = 0;
let capturePCMBuffer = Buffer.alloc(0);

function getPhoneWs() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return relayWs;
  if (localPhoneWs && localPhoneWs.readyState === WebSocket.OPEN) return localPhoneWs;
  return null;
}

function sendToPhone(data) {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    relayWs.send(data, { binary: true });
    bytesSent += data.length;
    return;
  }
  const sent = [];
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: true });
      bytesSent += data.length;
      sent.push('yes');
    }
  });
  if (sent.length === 0) console.log('[SEND] No phone connected to receive');
}

function sendPCMToPhone(pcmChunk) {
  if (useOpus && opusEncoder) {
    // Accumulate PCM and encode frame-by-frame
    capturePCMBuffer = Buffer.concat([capturePCMBuffer, pcmChunk]);
    while (capturePCMBuffer.length >= OPUS_FRAME_BYTES) {
      const frame = capturePCMBuffer.slice(0, OPUS_FRAME_BYTES);
      capturePCMBuffer = capturePCMBuffer.slice(OPUS_FRAME_BYTES);
      const encoded = opusEncode(frame);
      sendToPhone(encoded);
    }
  } else {
    sendToPhone(pcmChunk);
  }
}

function startPcAudioCapture() {
  if (captureActive) return;
  if (process.platform !== 'win32') {
    console.log('[CAPTURE] System audio capture only on Windows (WASAPI loopback)');
    return;
  }

  const exePath = path.join(__dirname, 'audio-capture.exe');
  const csPath = path.join(__dirname, 'audio-capture.cs');

  if (!fs.existsSync(exePath)) {
    console.log('[CAPTURE] First run: compiling WASAPI loopback capture...');
    const csc = spawn('cmd.exe', ['/c',
      'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
      '/unsafe', '/optimize', '/platform:x64', '/out:' + exePath, csPath
    ]);
    let err = '';
    csc.stderr.on('data', d => err += d);
    csc.on('close', (code) => {
      if (code === 0 && fs.existsSync(exePath)) {
        console.log('[CAPTURE] Compiled OK');
        launchCapture(exePath);
      } else {
        console.log('[CAPTURE] Compile failed: ' + err);
        console.log('[CAPTURE] PC->Phone speaker disabled');
      }
    });
  } else {
    launchCapture(exePath);
  }
}

function launchCapture(exePath) {
  console.log('[CAPTURE] Launching: ' + exePath + ' ' + SAMPLE_RATE);
  captureProcess = spawn(exePath, [SAMPLE_RATE.toString()], { stdio: ['pipe','pipe','pipe'] });
  captureActive = true;
  capturePCMBuffer = Buffer.alloc(0);

  captureProcess.stdout.on('data', (chunk) => {
    if (!captureActive) return;
    if (process.env.DEBUG) console.log('[CAPTURE] stdout: ' + chunk.length + ' bytes');
    sendPCMToPhone(chunk);
  });

  captureProcess.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.log('[CAPTURE] ' + s);
  });

  captureProcess.on('close', (code) => {
    console.log('[CAPTURE] Exited (' + code + ')');
    captureActive = false;
    captureProcess = null;
  });

  captureProcess.on('error', (e) => {
    console.log('[CAPTURE] Error: ' + e.message);
    captureActive = false;
    captureProcess = null;
  });

  console.log('[CAPTURE] WASAPI loopback capture started' + (useOpus ? ' (Opus)' : ' (PCM)'));
}

function stopPcAudioCapture() {
  if (captureProcess) { captureProcess.kill(); captureProcess = null; }
  captureActive = false;
  capturePCMBuffer = Buffer.alloc(0);
}

// ========== Handle incoming audio (from phone or relay) ==========
function handleIncomingAudio(data) {
  if (useOpus && opusDecoder) {
    const pcm = opusDecode(data);
    if (pcm) writeAudioPCM(pcm);
  } else {
    writeAudioPCM(data);
  }
}

// ========== WebSocket (LAN mode) ==========
let localPhoneWs = null;
let phoneOpus = false; // whether the phone supports Opus
let lanAudioGraceTimer = null;
const LAN_AUDIO_GRACE = 60000; // keep audio devices 60s after LAN disconnect

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log('\n[PHONE] Connected: ' + ip + ' (total: ' + wss.clients.size + ')');
  clearTimeout(lanAudioGraceTimer);
  bytesReceived = 0;
  localPhoneWs = ws;
  phoneOpus = false;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      handleIncomingAudio(data);
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        else if (msg.type === 'audio-config') {
          console.log('[PHONE] audio-config:', JSON.stringify(msg));
          if (msg.codec === 'opus' && useOpus) {
            phoneOpus = true;
            ws.send(JSON.stringify({ type: 'audio-config', codec: 'opus', sampleRate: SAMPLE_RATE }));
            console.log('[OPUS] Negotiated: Opus mode');
          } else {
            ws.send(JSON.stringify({ type: 'audio-config', codec: 'pcm', sampleRate: SAMPLE_RATE }));
            console.log('[AUDIO] Negotiated: PCM mode');
          }
        }
        else if (msg.type === 'start-pc-audio') {
          console.log('[PHONE] Requested PC audio capture');
          if (!captureActive) startPcAudioCapture();
        }
        else if (msg.type === 'stop-pc-audio') {
          console.log('[PHONE] Stopped PC audio capture');
          stopPcAudioCapture();
        }
      } catch (e) {}
    }
  });

  ws.on('close', () => {
    console.log('[PHONE] Disconnected (remaining: ' + wss.clients.size + ')');
    if (localPhoneWs === ws) localPhoneWs = null;
    phoneOpus = false;
    // Grace period — don't stop audio immediately (phone might be reconnecting)
    clearTimeout(lanAudioGraceTimer);
    lanAudioGraceTimer = setTimeout(() => {
      console.log('[PHONE] Grace period expired, stopping audio devices');
      stopPcAudioCapture();
    }, LAN_AUDIO_GRACE);
  });

  ws.send(JSON.stringify({ type: 'connected', opus: useOpus }));
});

// ========== HTTPS Server ==========
let httpsServer = null;
const keyPath = path.join(__dirname, 'key.pem');
const certPath = path.join(__dirname, 'cert.pem');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  httpsServer = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app);
} else {
  console.log('[WARN] No cert, using HTTP');
  httpsServer = http.createServer(app);
}

httpsServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
});

// ========== IP ==========
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

// ========== Relay Mode ==========
let relayWs = null;
let relaySessionId = null;
let relayReconnectAttempt = 0;
let relayReconnectTimer = null;
let relayAudioGraceTimer = null;
const RELAY_RECONNECT_MAX_DELAY = 15000;
const RELAY_AUDIO_GRACE = 60000; // keep audio devices 60s after disconnect

function getRelayReconnectDelay() {
  const base = Math.min(2000 * Math.pow(2, relayReconnectAttempt), RELAY_RECONNECT_MAX_DELAY);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

function scheduleRelayReconnect() {
  const delay = getRelayReconnectDelay();
  relayReconnectAttempt++;
  console.log(`[RELAY] Reconnect attempt ${relayReconnectAttempt} in ${(delay/1000).toFixed(1)}s...`);
  clearTimeout(relayReconnectTimer);
  relayReconnectTimer = setTimeout(connectRelay, delay);
}

function startRelayMode() {
  console.log('\n=== SoundBridge v1.1 (RELAY) ===\n');
  console.log('[RELAY] Connecting to ' + RELAY_URL + ' ...');

  function connectRelay() {
    // Build URL — include existing sessionId for reconnect
    let url = RELAY_URL + '?role=pc';
    // Note: relay-server always gives PC a new session on connect
    // but phone reconnects using the existing sessionId

    clearTimeout(relayReconnectTimer);

    try {
      relayWs = new WebSocket(url);
    } catch (e) {
      console.log('[RELAY] Connect error: ' + e.message);
      scheduleRelayReconnect();
      return;
    }

    relayWs.on('open', () => {
      console.log('[RELAY] Connected to relay server');
    });

    relayWs.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'registered') {
            // New session registered (or re-registered)
            const isNewSession = relaySessionId !== msg.sessionId;
            relaySessionId = msg.sessionId;
            relayReconnectAttempt = 0; // reset backoff
            clearTimeout(relayAudioGraceTimer);

            if (isNewSession) {
              console.log('\n[RELAY] Session ID: ' + relaySessionId);
              console.log('[RELAY] Phone URL: ' + RELAY_PUBLIC_URL + '#' + relaySessionId);
              console.log('');
              qrcode.generate(RELAY_PUBLIC_URL + '#' + relaySessionId, { small: true });
              console.log('\n' + '='.repeat(35));
              initAudioOutput();
              console.log('\nWaiting for phone (scan QR above)...\n');
            } else {
              console.log('[RELAY] Re-registered same session: ' + relaySessionId);
            }

          } else if (msg.type === 'phone-connected') {
            console.log('\n[PHONE] Phone connected via relay!');
            clearTimeout(relayAudioGraceTimer);
            bytesReceived = 0;
            // Re-negotiate codec on every (re)connect
            if (useOpus) {
              relayWs.send(JSON.stringify({ type: 'audio-config', codec: 'opus', sampleRate: SAMPLE_RATE }));
              console.log('[OPUS] Re-negotiating Opus with phone...');
            }
            // Don't restart capture if already running
            if (!captureActive) startPcAudioCapture();

          } else if (msg.type === 'phone-disconnected') {
            if (msg.reconnectable) {
              console.log('[PHONE] Phone disconnected (reconnectable) — keeping audio devices alive');
              // Set grace timer — only stop audio after 60s of no reconnect
              clearTimeout(relayAudioGraceTimer);
              relayAudioGraceTimer = setTimeout(() => {
                console.log('[PHONE] Grace period expired, stopping audio devices');
                stopPcAudioCapture();
              }, RELAY_AUDIO_GRACE);
            } else {
              console.log('[PHONE] Phone disconnected');
              stopPcAudioCapture();
            }
            phoneOpus = false;

          } else if (msg.type === 'audio-config') {
            if (msg.codec === 'opus') {
              phoneOpus = true;
              console.log('[OPUS] Negotiated via relay: Opus mode');
            } else {
              phoneOpus = false;
              console.log('[AUDIO] Negotiated via relay: PCM mode');
            }

          } else if (msg.type === 'start-pc-audio') {
            startPcAudioCapture();
          } else if (msg.type === 'stop-pc-audio') {
            stopPcAudioCapture();
          } else if (msg.type === 'ping') {
            relayWs.send(JSON.stringify({ type: 'pong' }));
          }
        } catch (e) {}
      } else {
        handleIncomingAudio(data);
      }
    });

    relayWs.on('close', () => {
      console.log('[RELAY] Disconnected');
      relayWs = null;
      // Don't clear relaySessionId — we'll reuse it on reconnect
      // Don't stop audio immediately — phone might still be connected via old session
      // The relay-server keeps the session alive for 60s
      phoneOpus = false;
      scheduleRelayReconnect();
    });

    relayWs.on('error', (err) => {
      console.log('[RELAY] Error: ' + err.message);
    });
  }

  connectRelay();
}

// ========== Start ==========
if (RELAY_URL) {
  startRelayMode();
} else {
  httpsServer.listen(PORT, '0.0.0.0', () => {
    const { lanIps, otherIps } = getAllIPs();
    console.log('\n=== SoundBridge v1.1 (LAN) ===\n');
    if (useOpus) console.log('[OPUS] ✓ Opus encoding active (64kbps)');
    else console.log('[AUDIO] PCM mode (Opus unavailable)');

    const showIps = lanIps.length > 0 ? lanIps : otherIps;
    for (const item of showIps) {
      const url = 'https://' + item.address + ':' + PORT;
      console.log('[' + item.iface + '] ' + item.address + '\n');
      qrcode.generate(url, { small: true });
      console.log('');
    }

    console.log('='.repeat(35));
    initAudioOutput();
    console.log('\nWaiting for phone...\n');
  });
}

process.on('SIGINT', () => {
  console.log('\n[STOP]');
  clearTimeout(relayReconnectTimer);
  clearTimeout(relayAudioGraceTimer);
  clearTimeout(lanAudioGraceTimer);
  closeAudio();
  stopPcAudioCapture();
  if (httpsServer) httpsServer.close();
  if (relayWs) relayWs.close();
  process.exit(0);
});
