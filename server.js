/**
 * Dashboard Server
 * Run separately: node dashboard/server.js
 * Or together:    npm run start:all
 * 
 * Connects to the bot's socket.io on port 3000 and
 * serves the browser dashboard at http://localhost:4000
 */
require('dotenv').config();
const express  = require('express');
const http     = require('http');
const path     = require('path');
const { Server: SocketIO } = require('socket.io');
const { io: clientIO }    = require('socket.io-client');

const BOT_PORT  = parseInt(process.env.DASHBOARD_PORT || '3000');
const UI_PORT   = parseInt(process.env.UI_PORT || '4000');

const app    = express();
const server = http.createServer(app);
const io     = new SocketIO(server, { cors: { origin: '*' } });

// Serve the dashboard HTML
app.use(express.static(path.join(__dirname)));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_, res) => res.json({ ok: true }));

// Bridge: bot → browser
const botSocket = clientIO(`http://localhost:${BOT_PORT}`, {
  reconnectionDelay: 1000, reconnectionDelayMax: 5000,
});

const EVENTS = ['stats', 'trade', 'opportunities', 'risk'];

botSocket.on('connect', () => {
  console.log(`[Dashboard] Connected to bot on port ${BOT_PORT}`);
  io.emit('bot_status', { connected: true });
});
botSocket.on('disconnect', () => {
  console.log('[Dashboard] Bot disconnected');
  io.emit('bot_status', { connected: false });
});

EVENTS.forEach(evt => {
  botSocket.on(evt, data => {
    io.emit(evt, data);
  });
});

// Browser client connected
io.on('connection', (socket) => {
  console.log(`[Dashboard] Browser client connected: ${socket.id}`);
  socket.emit('bot_status', { connected: botSocket.connected });
});

server.listen(UI_PORT, () => {
  console.log(`\n🖥️  Dashboard running at http://localhost:${UI_PORT}\n`);
});
