/**
 * Voice Relay Server v1.0
 * 部署在腾讯云，作为 PC 和手机之间的 WebSocket 中继
 *
 * 架构：手机浏览器 ←WSS→ Relay ←WSS→ PC Node.js
 * PC 端主动连接 relay，手机通过 session ID 配对
 */

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3212;

// ========== Sessions ==========
// session: { id, pc: ws, phone: ws, createdAt }
const sessions = new Map();

function generateId() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // 6位短码
}

function cleanupSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.pc && s.pc.readyState === WebSocket.OPEN) {
    try { s.pc.close(1000, 'session cleanup'); } catch (e) {}
  }
  if (s.phone && s.phone.readyState === WebSocket.OPEN) {
    try { s.phone.close(1000, 'session cleanup'); } catch (e) {}
  }
  sessions.delete(id);
}

// 定期清理过期 session（30分钟无数据）
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > 30 * 60 * 1000) {
      console.log(`[CLEANUP] Session ${id} expired`);
      cleanupSession(id);
    }
  }
}, 60 * 1000);

// ========== Express ==========
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sessions: sessions.size,
    uptime: process.uptime(),
  });
});

// 列出活跃 session（调试用）
app.get('/sessions', (req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({
      id,
      hasPC: !!s.pc && s.pc.readyState === WebSocket.OPEN,
      hasPhone: !!s.phone && s.phone.readyState === WebSocket.OPEN,
      age: Math.round((Date.now() - s.createdAt) / 1000) + 's',
    });
  }
  res.json({ sessions: list });
});

const server = http.createServer(app);

// ========== WebSocket ==========
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role'); // 'pc' or 'phone'
  const sid = url.searchParams.get('session'); // session id (phone 用)

  console.log(`[WS] Connection from ${ip}, role=${role}, session=${sid}`);

  if (role === 'pc') {
    // PC 注册新 session
    const id = generateId();
    const session = { id, pc: ws, phone: null, createdAt: Date.now() };
    sessions.set(id, session);

    ws.send(JSON.stringify({ type: 'registered', sessionId: id }));
    console.log(`[PC] Registered session ${id}`);

    ws.on('message', (data, isBinary) => {
      // PC → relay → phone
      const s = sessions.get(id);
      if (s && s.phone && s.phone.readyState === WebSocket.OPEN) {
        s.phone.send(data, { binary: isBinary });
      }
    });

    ws.on('close', () => {
      console.log(`[PC] Disconnected session ${id}`);
      const s = sessions.get(id);
      if (s && s.phone && s.phone.readyState === WebSocket.OPEN) {
        s.phone.send(JSON.stringify({ type: 'peer-disconnected', peer: 'pc' }));
      }
      // 给 phone 30s 重连时间
      setTimeout(() => {
        const s2 = sessions.get(id);
        if (s2 && (!s2.pc || s2.pc.readyState !== WebSocket.OPEN)) {
          cleanupSession(id);
        }
      }, 30 * 1000);
    });

  } else if (role === 'phone') {
    // 手机加入已有 session
    if (!sid) {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing session ID' }));
      ws.close(4001, 'Missing session ID');
      return;
    }

    const s = sessions.get(sid.toUpperCase());
    if (!s) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      ws.close(4002, 'Session not found');
      return;
    }

    if (s.phone && s.phone.readyState === WebSocket.OPEN) {
      // 踢掉旧 phone 连接
      try { s.phone.close(1000, 'replaced'); } catch (e) {}
    }

    s.phone = ws;
    ws.send(JSON.stringify({ type: 'connected', sessionId: sid }));
    console.log(`[PHONE] Joined session ${sid}`);

    // 通知 PC 有手机连上了
    if (s.pc && s.pc.readyState === WebSocket.OPEN) {
      s.pc.send(JSON.stringify({ type: 'phone-connected' }));
    }

    ws.on('message', (data, isBinary) => {
      // phone → relay → PC
      const sess = sessions.get(sid.toUpperCase());
      if (sess && sess.pc && sess.pc.readyState === WebSocket.OPEN) {
        sess.pc.send(data, { binary: isBinary });
      }
    });

    ws.on('close', () => {
      console.log(`[PHONE] Disconnected from session ${sid}`);
      const sess = sessions.get(sid.toUpperCase());
      if (sess) {
        sess.phone = null;
        if (sess.pc && sess.pc.readyState === WebSocket.OPEN) {
          sess.pc.send(JSON.stringify({ type: 'phone-disconnected' }));
        }
      }
    });

  } else {
    ws.close(4003, 'Invalid role');
  }
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n=== Voice Relay Server v1.0 ===`);
  console.log(`Listening on 127.0.0.1:${PORT}`);
  console.log(`================================\n`);
});

process.on('SIGINT', () => {
  console.log('\n[STOP] Cleaning up...');
  for (const [id] of sessions) cleanupSession(id);
  server.close();
  process.exit(0);
});
