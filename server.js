/**
 * Voice Assistant Server v0.3
 * PC端服务 - 接收手机音频流
 * 
 * 输出策略：
 *   1. 检测 ffmpeg → 播放到默认音频设备
 *   2. 无 ffmpeg → 保存为 WAV 文件（调试模式）
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const qrcode = require('qrcode-terminal');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const SAMPLE_RATE = 48000;
const CHANNELS = 1;

// ========== HTTP Server ==========
const app = express();
const server = http.createServer(app);
app.use(express.static(path.join(__dirname, 'public')));

// ========== 音频输出 ==========
let ffmpegProcess = null;
let wavStream = null;
let wavPath = null;
let bytesReceived = 0;
let useFfmpeg = false;

function initAudioOutput() {
  // 尝试 ffmpeg
  try {
    const test = spawn('ffmpeg', ['-version']);
    test.on('error', () => {
      console.log('\n⚠️  ffmpeg 未安装');
      console.log('   → 使用文件保存模式（调试）');
      console.log('   → 安装 ffmpeg 后可实时播放: https://ffmpeg.org/download.html');
      console.log('   → 推荐用 winget install Gyan.FFmpeg');
      initFileOutput();
    });
    test.on('close', (code) => {
      if (code === 0) {
        console.log('✅ ffmpeg 已就绪');
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
    '0',  // 默认音频设备
  ];

  try {
    ffmpegProcess = spawn('ffmpeg', args);
    ffmpegProcess.stdin.on('error', () => {});
    ffmpegProcess.stderr.on('data', () => {}); // 静默
    ffmpegProcess.on('close', (code) => {
      if (code !== 0 && !wavStream) {
        console.log('⚠️  ffmpeg 播放失败，切换文件模式');
        initFileOutput();
      }
    });
    useFfmpeg = true;
    console.log('🔊 音频 → ffmpeg → 默认音频设备');
  } catch (e) {
    initFileOutput();
  }
}

function initFileOutput() {
  const outputDir = path.join(__dirname, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  wavPath = path.join(outputDir, `recording_${Date.now()}.wav`);
  
  wavStream = fs.createWriteStream(wavPath);
  // 写入占位 WAV header（44字节），录音结束后回填
  const header = Buffer.alloc(44);
  wavStream.write(header);
  
  console.log(`📁 音频保存到: ${wavPath}`);
  console.log('   按 Ctrl+C 结束后可播放验证');
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
    // 回填 WAV header
    const fd = fs.openSync(wavPath, 'r+');
    const header = Buffer.alloc(44);
    const dataLength = bytesReceived;
    
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);            // PCM
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28); // byte rate
    header.writeUInt16LE(CHANNELS * 2, 32); // block align
    header.writeUInt16LE(16, 34);           // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);
    
    fs.writeSync(fd, header, 0, 44, 0);
    fs.closeSync(fd);
    wavStream.end();
  }
}

// ========== WebSocket Server ==========
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`\n📱 手机已连接: ${clientIp} (共 ${wss.clients.size} 个连接)`);
  bytesReceived = 0;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      writeAudio(data);
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        else if (msg.type === 'audio-config') console.log(`🎵 配置: rate=${msg.sampleRate}`);
      } catch (e) {}
    }
  });

  ws.on('close', () => {
    console.log(`📱 断开 (剩余 ${wss.clients.size})`);
    if (wss.clients.size === 0 && bytesReceived > 0) {
      finalizeWav();
      const sec = (bytesReceived / (SAMPLE_RATE * 2)).toFixed(1);
      console.log(`📊 本段录音 ${sec} 秒 (${bytesReceived} bytes)`);
    }
  });

  ws.send(JSON.stringify({ type: 'connected' }));
});

// ========== IP ==========
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

// ========== 启动 ==========
server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIP();
  
  console.log('\n🎙️  Voice Assistant - 语音助手');
  console.log('═'.repeat(40));

  for (const ip of ips) {
    const url = `http://${ip}:${PORT}`;
    console.log(`\n📡 ${ip}:`);
    console.log(`   手机访问: ${url}`);
    console.log(`   二维码:\n`);
    qrcode.generate(url, { small: true });
  }

  console.log('\n' + '═'.repeat(40));
  initAudioOutput();
  console.log('\n⏳ 等待手机连接...\n');
});

process.on('SIGINT', () => {
  console.log('\n\n🛑 关闭中...');
  if (ffmpegProcess) ffmpegProcess.kill();
  finalizeWav();
  if (bytesReceived > 0) {
    const sec = (bytesReceived / (SAMPLE_RATE * 2)).toFixed(1);
    console.log(`📊 总计录音 ${sec} 秒`);
  }
  if (wavPath) console.log(`📁 文件: ${wavPath}`);
  server.close();
  process.exit(0);
});
