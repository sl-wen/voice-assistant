/**
 * Voice Relay Server v1.1 — Auto-Reconnect Edition
 * 部署在腾讯云，作为 PC 和手机之间的 WebSocket 中继
 *
 * v1.1 changes:
 *   - Phone/PC 断开后保留 session 60s（原 0s/30s）
 *   - Phone 可重连同一 session（不踢掉旧 session，直接替换）
 *   - PC 重连时分配新 session（旧 session 等待超时清理）
 *   - 心跳检测：30s 无数据视为半死连接，发送 ping
 *   - 双方都断开 60s 后才真正清理 session
 *
 * 架构：手机浏览器 ←WSS→ Relay ←WSS→ PC Node.js
 */

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3212;
const SESSION_TTL = 60 * 1000;       // session 存活 60 分钟
const RECONNECT_GRACE = 60 * 1000;   // 断开后保留 60s 等待重连
const HEARTBEAT_INTERVAL = 30 * 1000; // 30s 心跳

// ========== Sessions ==========
const sessions = new Map();

function generateId() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function sessionAge(s) {
  return Date.now() - s.createdAt;
}

function sessionIsDead(s) {
  // 双方都断开，且超过 grace period
  const pcDead = !s.pc || s.pc.readyState !== WebSocket.OPEN;
  const phoneDead = !s.phone || s.phone.readyState !== WebSocket.OPEN;
  const graceExpired = s.lastDisconnect && (Date.now() - s.lastDisconnect > RECONNECT_GRACE);

  if (pcDead && phoneDead && graceExpired) return true;
  if (sessionAge(s) > SESSION_TTL) return true;
  return false;
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
  clearInterval(s.heartbeatTimer);
  sessions.delete(id);
}

// Periodic cleanup
setInterval(() => {
  for (const [id, s] of sessions) {
    if (sessionIsDead(s)) {
      console.log(`[CLEANUP] Session ${id} expired (age=${Math.round(sessionAge(s)/1000)}s)`);
      cleanupSession(id);
    }
  }
}, 10 * 1000);

// ========== Express ==========
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sessions: sessions.size,
    uptime: process.uptime(),
  });
});

app.get('/sessions', (req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({
      id,
      hasPC: !!s.pc && s.pc.readyState === WebSocket.OPEN,
      hasPhone: !!s.phone && s.phone.readyState === WebSocket.OPEN,
      age: Math.round(sessionAge(s) / 1000) + 's',
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
  const role = url.searchParams.get('role');
  const sid = url.searchParams.get('session');

  console.log(`[WS] Connection from ${ip}, role=${role}, session=${sid}`);

  if (role === 'pc') {
    // PC registers a new session
    const id = generateId();
    const session = {
      id,
      pc: ws,
      phone: null,
      createdAt: Date.now(),
      lastDisconnect: null,
      heartbeatTimer: null,
    };
    sessions.set(id, session);

    ws.send(JSON.stringify({ type: 'registered', sessionId: id }));
    console.log(`[PC] Registered session ${id}`);

    // Heartbeat: detect dead PC connections
    session.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, HEARTBEAT_INTERVAL);

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
      if (s) {
        s.pc = null;
        s.lastDisconnect = Date.now();
        // Notify phone
        if (s.phone && s.phone.readyState === WebSocket.OPEN) {
          s.phone.send(JSON.stringify({ type: 'peer-disconnected', peer: 'pc', reconnectable: true }));
        }
      }
    });

  } else if (role === 'phone') {
    // Phone joins an existing session (or reconnects)
    if (!sid) {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing session ID' }));
      ws.close(4001, 'Missing session ID');
      return;
    }

    const sidUpper = sid.toUpperCase();
    const s = sessions.get(sidUpper);
    if (!s) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      ws.close(4002, 'Session not found');
      return;
    }

    // Replace old phone connection (if any)
    if (s.phone && s.phone.readyState === WebSocket.OPEN) {
      try { s.phone.close(1000, 'replaced by new connection'); } catch (e) {}
    }

    s.phone = ws;
    s.lastDisconnect = null; // Clear disconnect timer
    ws.send(JSON.stringify({ type: 'connected', sessionId: sidUpper }));
    console.log(`[PHONE] ${s.pc ? 'Reconnected' : 'Joined'} session ${sidUpper}`);

    // Notify PC
    if (s.pc && s.pc.readyState === WebSocket.OPEN) {
      s.pc.send(JSON.stringify({ type: 'phone-connected' }));
    }

    ws.on('message', (data, isBinary) => {
      // phone → relay → PC
      const sess = sessions.get(sidUpper);
      if (sess && sess.pc && sess.pc.readyState === WebSocket.OPEN) {
        sess.pc.send(data, { binary: isBinary });
      }
    });

    ws.on('close', () => {
      console.log(`[PHONE] Disconnected from session ${sidUpper}`);
      const sess = sessions.get(sidUpper);
      if (sess) {
        sess.phone = null;
        sess.lastDisconnect = Date.now();
        if (sess.pc && sess.pc.readyState === WebSocket.OPEN) {
          sess.pc.send(JSON.stringify({ type: 'phone-disconnected', reconnectable: true }));
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
  console.log(`\n=== Voice Relay Server v1.1 ===`);
  console.log(`Listening on 127.0.0.1:${PORT}`);
  console.log(`Session TTL: ${SESSION_TTL/1000}s, Reconnect grace: ${RECONNECT_GRACE/1000}s`);
  console.log(`=================================\n`);
});

process.on('SIGINT', () => {
  console.log('\n[STOP] Cleaning up...');
  for (const [id] of sessions) cleanupSession(id);
  server.close();
  process.exit(0);
});
