/**
 * Voice Assistant Server v0.2
 * PC端服务 - 接收手机音频流并写入虚拟音频设备
 * 
 * 音频输出策略（Windows）：
 *   1. 优先: 通过 PowerShell 调用 NAudio/CSCore 写入虚拟设备
 *   2. 备选: 通过 ffmpeg pipe 播放到指定设备
 *   3. 调试: 保存为 WAV 文件验证
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

// ========== 音频输出管理 ==========
let ffmpegProcess = null;
let wavStream = null;
let bytesReceived = 0;

function initAudioOutput() {
  // 策略: 用 ffmpeg 将 PCM 流写入 Windows 音频设备
  // ffmpeg -f s16le -ar 48000 -ac 1 -i pipe:0 -f waveformatex AudioRenderDevice
  // 
  // 或者更简单: ffmpeg 播放到指定设备
  // 先检测 ffmpeg 是否可用
  
  const ffmpeg = spawn('ffmpeg', ['-version']);
  ffmpeg.on('error', () => {
    console.log('\n⚠️  ffmpeg 未安装，音频将保存到文件');
    console.log('   安装: https://ffmpeg.org/download.html');
    initFileOutput();
  });
  ffmpeg.on('close', (code) => {
    if (code === 0) {
      console.log('✅ ffmpeg 已就绪');
      initFFmpegOutput();
    } else {
      initFileOutput();
    }
  });
}

function initFFmpegOutput() {
  // 使用 ffmpeg 将 PCM 数据播放到 Windows 默认音频设备
  // -f s16le: 输入格式 16bit PCM
  // -ar 48000: 采样率
  // -ac 1: 单声道
  // -f dshow / waveaudio: Windows 音频输出
  
  const args = [
    '-f', 's16le',           // 输入格式
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
    '-i', 'pipe:0',          // 从 stdin 读取
    '-f', 'waveaudio',       // Windows 音频输出
    '0',                     // 默认设备
  ];

  try {
    ffmpegProcess = spawn('ffmpeg', args);
    ffmpegProcess.stderr.on('data', (d) => {
      // 静默处理 ffmpeg 日志
    });
    ffmpegProcess.on('error', (e) => {
      console.log('⚠️  ffmpeg 播放失败，切换到文件模式');
      initFileOutput();
    });
    ffmpegProcess.on('close', (code) => {
      if (code !== 0 && !wavStream) {
        console.log(`⚠️  ffmpeg 退出 (code ${code})，切换到文件模式`);
        initFileOutput();
      }
    });
    console.log('🔊 音频将通过 ffmpeg 输出到默认设备');
  } catch (e) {
    console.log('⚠️  ffmpeg 不可用，切换到文件模式');
    initFileOutput();
  }
}

function initFileOutput() {
  // 调试模式: 保存音频到文件
  const outputPath = path.join(__dirname, 'output', `recording_${Date.now()}.wav`);
  fs.mkdirSync(path.join(__dirname, 'output'), { recursive: true });
  
  // WAV header + PCM data
  const header = Buffer.alloc(44);
  writeWavHeader(header, 0, SAMPLE_RATE, CHANNELS, 16);
  
  wavStream = fs.createWriteStream(outputPath);
  wavStream.write(header);
  
  console.log(`📁 调试模式: 音频将保存到 ${outputPath}`);
  console.log('   (安装 ffmpeg 后可实时播放到音频设备)');
}

function writeWavHeader(buf, dataLength, sampleRate, channels, bitsPerSample) {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLength, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);           // chunk size
  buf.writeUInt16LE(1, 20);            // PCM format
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLength, 40);
}

function writeAudio(data) {
  bytesReceived += data.length;
  
  if (ffmpegProcess && ffmpegProcess.stdin.writable) {
    ffmpegProcess.stdin.write(data);
  } else if (wavStream) {
    wavStream.write(data);
    // 更新 WAV header
    const totalLen = bytesReceived;
    wavStream.write = wavStream.write; // keep writing
  }
}

// ========== WebSocket Server ==========
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`\n📱 手机已连接: ${clientIp}`);
  console.log(`   当前连接数: ${wss.clients.size}`);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      writeAudio(data);
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        } else if (msg.type === 'audio-config') {
          console.log(`🎵 音频配置: sampleRate=${msg.sampleRate}`);
        }
      } catch (e) {}
    }
  });

  ws.on('close', () => {
    console.log(`📱 手机已断开 (剩余: ${wss.clients.size})`);
  });

  ws.send(JSON.stringify({ type: 'connected', message: 'Voice Assistant 已连接' }));
});

// ========== 获取本机 IP ==========
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ========== 启动 ==========
server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  const url = `http://${localIP}:${PORT}`;

  console.log('\n🎙️  Voice Assistant - 语音助手');
  console.log('================================');
  console.log(`\n📡 服务器已启动`);
  console.log(`   本机: http://localhost:${PORT}`);
  console.log(`   手机: ${url}`);
  console.log(`\n📱 手机扫码连接:\n`);

  qrcode.generate(url, { small: true });

  console.log(`\n================================`);

  initAudioOutput();

  console.log('\n⏳ 等待手机连接...\n');
});

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n\n🛑 正在关闭...');
  if (ffmpegProcess) ffmpegProcess.kill();
  if (wavStream) {
    // 更新 WAV 文件头
    wavStream.end();
  }
  console.log(`📊 本次共接收 ${bytesReceived} 字节音频数据`);
  server.close();
  process.exit(0);
});
