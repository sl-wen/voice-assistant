/**
 * Voice Assistant Server v0.5
 * Clean rewrite - phone mic -> PC speaker
 * 
 * Zero dependency audio playback on Windows:
 *   Uses PowerShell + .NET NAudio-style approach
 *   Falls back to WAV file if PS not available
 */

const express = require('express');
const https = require('https');
const http = require('http');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode-terminal');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const SAMPLE_RATE = 48000;

// ========== Express ==========
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ========== WebSocket (noServer) ==========
const wss = new WebSocketServer({ noServer: true });

// ========== Audio Output ==========
let audioProcess = null;
let audioMode = 'none'; // 'ps' | 'file' | 'none'
let wavFd = null;
let wavPath = null;
let bytesReceived = 0;
const audioBuffer = [];  // Buffer incoming data until audio process is ready

function initAudioOutput() {
  if (process.platform === 'win32') {
    initPSAudio();
  } else {
    initFileOutput();
  }
}

function initPSAudio() {
  // Use a minimal inline PowerShell script to play PCM
  // Writes raw PCM to a temp WAV file and plays it in chunks
  const psScript = `
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    # Just tell Node we're ready
    Write-Output "READY"
  `;

  // Better approach: Use .NET MediaPlayer via PowerShell
  // But actually, the simplest zero-dep approach is:
  // Node.js -> write to temp .wav -> PowerShell plays it
  
  // For REAL-TIME: Use node's built-in speaker capability
  // Since we need real-time streaming, let's use a pipe approach
  // with PowerShell reading stdin

  try {
    // Create a PowerShell process that reads PCM from stdin and plays via WinMM
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
    
    [StructLayout(LayoutKind.Sequential)]
    public struct F { public short tag; public short ch; public int sr; public int br; public short ba; public short bps; public short cb; }
    
    [StructLayout(LayoutKind.Sequential)]
    public struct H { public IntPtr data; public int len; public int rec; public IntPtr user; public int flags; public int loops; public IntPtr next; public IntPtr res; }
    
    public static void Play(Stream stdin) {
        F fmt = new F();
        fmt.tag = 1; fmt.ch = 1; fmt.sr = 48000; fmt.bps = 16;
        fmt.ba = 2; fmt.br = 96000; fmt.cb = 0;
        
        IntPtr hw;
        if (waveOutOpen(out hw, -1, ref fmt, IntPtr.Zero, IntPtr.Zero, 0) != 0) {
            Console.Error.WriteLine("OPEN_FAIL"); return;
        }
        
        byte[] buf = new byte[9600];
        while (true) {
            int r = stdin.Read(buf, 0, buf.Length);
            if (r <= 0) break;
            
            IntPtr p = Marshal.AllocHGlobal(r);
            Marshal.Copy(buf, 0, p, r);
            
            H hdr = new H();
            hdr.data = p;
            hdr.len = r;
            
            IntPtr hp = Marshal.AllocHGlobal(Marshal.SizeOf(hdr));
            Marshal.StructureToPtr(hdr, hp, false);
            
            waveOutPrepareHeader(hw, hp, Marshal.SizeOf(hdr));
            waveOutWrite(hw, hp, Marshal.SizeOf(hdr));
            
            int wait = 0;
            while (wait < 2000) {
                Thread.Sleep(1);
                H cur = (H)Marshal.PtrToStructure(hp, typeof(H));
                if ((cur.flags & 1) != 0) break;
                wait++;
            }
            
            waveOutUnprepareHeader(hw, hp, Marshal.SizeOf(hdr));
            Marshal.FreeHGlobal(p);
            Marshal.FreeHGlobal(hp);
        }
        waveOutClose(hw);
    }
}
"@

[PCMPlayer]::Play([Console]::OpenStandardInput())
`;

    audioProcess = spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-NoProfile',
      '-NonInteractive',
      '-Command', inlinePS
    ]);

    audioProcess.stdin.on('error', () => {});
    audioProcess.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s && s !== 'READY') console.log('[PS-AUDIO] ' + s);
    });
    audioProcess.on('close', (code) => {
      console.log('[PS-AUDIO] Exited (code ' + code + ')');
      audioProcess = null;
      audioMode = 'none';
    });
    audioProcess.on('error', (e) => {
      console.log('[PS-AUDIO] Error: ' + e.message);
      audioProcess = null;
      initFileOutput();
    });

    audioMode = 'ps';
    console.log('[OUT] Audio -> PowerShell WinMM -> default speaker');

  } catch (e) {
    console.log('[OUT] PS failed: ' + e.message);
    initFileOutput();
  }
}

function initFileOutput() {
  const dir = path.join(__dirname, 'output');
  fs.mkdirSync(dir, { recursive: true });
  wavPath = path.join(dir, 'recording_' + Date.now() + '.wav');
  wavFd = fs.openSync(wavPath, 'w');
  // Placeholder WAV header
  fs.writeSync(wavFd, Buffer.alloc(44));
  audioMode = 'file';
  console.log('[OUT] Saving to: ' + wavPath);
  console.log('     Ctrl+C to stop and play the file');
}

function writeAudio(data) {
  bytesReceived += data.length;
  if (audioMode === 'ps' && audioProcess && audioProcess.stdin.writable) {
    audioProcess.stdin.write(data);
  } else if (audioMode === 'file' && wavFd) {
    fs.writeSync(wavFd, data);
  }
}

function closeAudio() {
  if (audioProcess) {
    audioProcess.stdin.end();
    audioProcess = null;
  }
  if (wavFd && wavPath) {
    // Fix WAV header
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + bytesReceived, 4);
    h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22); h.writeUInt32LE(SAMPLE_RATE, 24);
    h.writeUInt32LE(SAMPLE_RATE * 2, 28);
    h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(bytesReceived, 40);
    fs.writeSync(wavFd, h, 0, 44, 0);
    fs.closeSync(wavFd);
    wavFd = null;
    if (bytesReceived > 0) console.log('[FILE] Saved: ' + wavPath + ' (' + (bytesReceived / SAMPLE_RATE / 2).toFixed(1) + 's)');
  }
}

// ========== WebSocket ==========
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log('\n[PHONE] Connected: ' + ip + ' (total: ' + wss.clients.size + ')');
  bytesReceived = 0;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      writeAudio(data);
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        else if (msg.type === 'audio-config') console.log('[AUDIO] rate=' + msg.sampleRate);
      } catch (e) {}
    }
  });

  ws.on('close', () => {
    console.log('[PHONE] Disconnected (remaining: ' + wss.clients.size + ')');
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

// WebSocket upgrade
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

// ========== Start ==========
httpsServer.listen(PORT, '0.0.0.0', () => {
  const { lanIps, otherIps } = getAllIPs();
  console.log('\n=== Voice Assistant v0.5 ===\n');

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

process.on('SIGINT', () => {
  console.log('\n[STOP]');
  closeAudio();
  httpsServer.close();
  process.exit(0);
});
