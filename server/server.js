// torodem chat — server.js
// Deploy to Koyeb from GitHub. Free, no credit card.
// Data saved to .data/db.json (persists across restarts on Koyeb).

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT     = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '.data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');

// ── Persistent storage ────────────────────────────────────────

function loadDB() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) { console.error('loadDB:', e.message); }
    return { accounts: {}, servers: {}, invites: {}, messages: {}, dms: {} };
}

function saveDB() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); }
    catch (e) { console.error('saveDB:', e.message); }
}

let db = loadDB();

// ── WebSocket rooms ───────────────────────────────────────────

const rooms = {};

function joinRoom(key, ws) {
    if (!rooms[key]) rooms[key] = new Set();
    rooms[key].add(ws);
}

function leaveAllRooms(ws) {
    for (const key of Object.keys(rooms)) {
        rooms[key].delete(ws);
        if (rooms[key].size === 0) delete rooms[key];
    }
}

function broadcast(key, payload, skip) {
    if (!rooms[key]) return;
    const msg = JSON.stringify(payload);
    for (const ws of rooms[key]) {
        if (ws !== skip && ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
}

// ── HTTP helpers ──────────────────────────────────────────────

const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function send(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(data));
}

function readBody(req) {
    return new Promise(resolve => {
        let raw = '';
        req.on('data', c => { raw += c; if (raw.length > 50000) raw = '{}'; });
        req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
        req.on('error', () => resolve({}));
    });
}

// ── HTTP server ───────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    const { method } = req;
    const url = new URL(req.url, 'http://x');
    const p   = url.pathname;

    if (method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

    // Health check — Koyeb requires this to know the app is running
    if (p === '/health' || p === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain', ...CORS });
        res.end('ok');
        return;
    }

    // POST /api/accounts — register
    if (p === '/api/accounts' && method === 'POST') {
        const b = await readBody(req);
        if (!b.username || !b.hash || !b.salt || !b.color) return send(res, 400, { error: 'missing fields' });
        const key = b.username.toLowerCase();
        if (db.accounts[key]) return send(res, 409, { error: 'username taken' });
        db.accounts[key] = {
            username: key, display_name: b.display_name || b.username,
            hash: b.hash, salt: b.salt, color: b.color,
            created_at: new Date().toISOString(),
        };
        saveDB();
        return send(res, 200, { ok: true });
    }

    // POST /api/login
    if (p === '/api/login' && method === 'POST') {
        const b   = await readBody(req);
        const acc = db.accounts[b.username?.toLowerCase()];
        if (!acc)              return send(res, 404, { error: 'account not found' });
        if (acc.hash !== b.hash) return send(res, 401, { error: 'wrong password' });
        return send(res, 200, { ok: true, display_name: acc.display_name, color: acc.color, salt: acc.salt });
    }

    // GET /api/accounts/:username
    if (p.startsWith('/api/accounts/') && method === 'GET') {
        const acc = db.accounts[decodeURIComponent(p.slice(14)).toLowerCase()];
        if (!acc) return send(res, 404, { error: 'not found' });
        return send(res, 200, { display_name: acc.display_name, color: acc.color, salt: acc.salt });
    }

    // GET /api/servers
    if (p === '/api/servers' && method === 'GET') {
        return send(res, 200, Object.values(db.servers));
    }

    // POST /api/servers
    if (p === '/api/servers' && method === 'POST') {
        const b = await readBody(req);
        if (!b.id || !b.name || !b.invite_code || !b.owner) return send(res, 400, { error: 'missing fields' });
        const srv = { id: b.id, name: b.name, description: b.description || '', invite_code: b.invite_code, owner: b.owner, created_at: new Date().toISOString() };
        db.servers[b.id] = srv;
        db.invites[b.invite_code] = b.id;
        if (!db.messages[b.id]) db.messages[b.id] = [];
        saveDB();
        return send(res, 200, srv);
    }

    // GET /api/invite/:code
    if (p.startsWith('/api/invite/') && method === 'GET') {
        const sid = db.invites[p.slice(12)];
        if (!sid) return send(res, 404, { error: 'invalid invite code' });
        const srv = db.servers[sid];
        if (!srv) return send(res, 404, { error: 'server not found' });
        return send(res, 200, srv);
    }

    send(res, 404, { error: 'not found' });
});

// ── WebSocket server ──────────────────────────────────────────

const wss = new WebSocketServer({ server });

// Server-side heartbeat: ping every client every 25s,
// terminate any that don't pong back (Koyeb drops idle sockets silently)
function heartbeat() { this.isAlive = true; }

const heartbeatTimer = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) { leaveAllRooms(ws); return ws.terminate(); }
        ws.isAlive = false;
        ws.ping();
    });
}, 25000);

wss.on('close', () => clearInterval(heartbeatTimer));

wss.on('connection', (ws, req) => {
    const url   = new URL(req.url, 'http://x');
    const match = url.pathname.match(/^\/ws\/(server|dm)\/(.+)$/);
    if (!match) { ws.close(); return; }

    const [, type, rawId] = match;
    const chanId  = decodeURIComponent(rawId);
    const roomKey = type + ':' + chanId;

    ws.isAlive = true;
    ws.on('pong', heartbeat);
    joinRoom(roomKey, ws);

    // Send history on connect
    const history = type === 'server'
        ? (db.messages[chanId] || []).slice(-200)
        : (db.dms[chanId]      || []).slice(-200);
    ws.send(JSON.stringify({ type: 'history', messages: history }));

    ws.on('message', raw => {
        const str = raw.toString();
        if (str === 'ping') { ws.send('pong'); return; }

        let msg;
        try { msg = JSON.parse(str); } catch { return; }
        if (!['msg', 'system'].includes(msg.type)) return;
        if (!msg.content || !msg.author) return;

        const record = {
            id:         Math.random().toString(36).slice(2),
            type:       msg.type,
            author:     String(msg.author).slice(0, 32),
            color:      msg.color || '#7c3aed',
            content:    String(msg.content).slice(0, 2000),
            created_at: new Date().toISOString(),
        };

        if (type === 'server') {
            if (!db.messages[chanId]) db.messages[chanId] = [];
            db.messages[chanId].push(record);
            if (db.messages[chanId].length > 500) db.messages[chanId].shift();
        } else {
            if (!db.dms[chanId]) db.dms[chanId] = [];
            db.dms[chanId].push(record);
            if (db.dms[chanId].length > 500) db.dms[chanId].shift();
        }
        saveDB();

        const out = { type: 'message', message: record };
        ws.send(JSON.stringify(out));
        broadcast(roomKey, out, ws);
    });

    ws.on('close', () => leaveAllRooms(ws));
    ws.on('error', () => leaveAllRooms(ws));
});

server.listen(PORT, () => console.log('torodem chat server on port', PORT));
