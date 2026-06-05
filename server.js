/**
 * Voice Assistant Server v0.7
 * Phone mic <-> PC speaker, with relay + PC audio capture
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

function writeAudio(data) {
  bytesReceived += data.length;
  if (audioMode === 'ps' && audioProcess && audioProcess.stdin.writable) audioProcess.stdin.write(data);
  else if (audioMode === 'file' && wavFd) fs.writeSync(wavFd, data);
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

function getPhoneWs() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return relayWs;
  if (localPhoneWs && localPhoneWs.readyState === WebSocket.OPEN) return localPhoneWs;
  // LAN mode: broadcast to all connected clients
  // (in LAN mode there's usually just one phone)
  return null;
}

function sendToPhone(data) {
  // Relay mode
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    relayWs.send(data, { binary: true });
    bytesSent += data.length;
    return;
  }
  // LAN mode: send to all connected phones
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
    // Compile C# -> exe
    const csc = spawn('cmd.exe', ['/c',
      'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
      '/unsafe', '/optimize', '/out:' + exePath, csPath
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

  captureProcess.stdout.on('data', (chunk) => {
    if (!captureActive) return;
    console.log('[CAPTURE] stdout: ' + chunk.length + ' bytes');
    sendToPhone(chunk);
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

  console.log('[CAPTURE] WASAPI loopback capture started');
}

function stopPcAudioCapture() {
  if (captureProcess) { captureProcess.kill(); captureProcess = null; }
  captureActive = false;
}

// ========== WebSocket (LAN mode) ==========
let localPhoneWs = null;

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log('\n[PHONE] Connected: ' + ip + ' (total: ' + wss.clients.size + ')');
  bytesReceived = 0;
  localPhoneWs = ws;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      writeAudio(data);
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        else if (msg.type === 'audio-config') console.log('[AUDIO] rate=' + msg.sampleRate);
        else if (msg.type === 'start-pc-audio') {
          console.log('[PHONE] Requested PC audio capture');
          startPcAudioCapture();
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
    stopPcAudioCapture();
  });

  ws.send(JSON.stringify({ type: 'connected' }));
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

function startRelayMode() {
  console.log('\n=== Voice Assistant v0.7 (RELAY) ===\n');
  console.log('[RELAY] Connecting to ' + RELAY_URL + ' ...');

  function connectRelay() {
    try {
      relayWs = new WebSocket(RELAY_URL + '?role=pc');
    } catch (e) {
      console.log('[RELAY] Connect error: ' + e.message);
      setTimeout(connectRelay, 5000);
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
            relaySessionId = msg.sessionId;
            console.log('\n[RELAY] Session ID: ' + relaySessionId);
            console.log('[RELAY] Phone URL: ' + RELAY_PUBLIC_URL + '#' + relaySessionId);
            console.log('');
            qrcode.generate(RELAY_PUBLIC_URL + '#' + relaySessionId, { small: true });
            console.log('\n' + '='.repeat(35));
            initAudioOutput();
            startPcAudioCapture();
            console.log('\nWaiting for phone (scan QR above)...\n');
          } else if (msg.type === 'phone-connected') {
            console.log('\n[PHONE] Phone connected via relay!');
            bytesReceived = 0;
            startPcAudioCapture();
          } else if (msg.type === 'phone-disconnected') {
            console.log('[PHONE] Phone disconnected from relay');
            closeAudio();
            stopPcAudioCapture();
          } else if (msg.type === 'start-pc-audio') {
            startPcAudioCapture();
          } else if (msg.type === 'stop-pc-audio') {
            stopPcAudioCapture();
          } else if (msg.type === 'ping') {
            relayWs.send(JSON.stringify({ type: 'pong' }));
          }
        } catch (e) {}
      } else {
        writeAudio(data);
      }
    });

    relayWs.on('close', () => {
      console.log('[RELAY] Disconnected, reconnecting in 5s...');
      relayWs = null;
      relaySessionId = null;
      stopPcAudioCapture();
      setTimeout(connectRelay, 5000);
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
    console.log('\n=== Voice Assistant v0.7 (LAN) ===\n');

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
  closeAudio();
  stopPcAudioCapture();
  if (httpsServer) httpsServer.close();
  if (relayWs) relayWs.close();
  process.exit(0);
});
