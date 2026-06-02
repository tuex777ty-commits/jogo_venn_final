const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// ── PostgreSQL (produção) ou JSON local (desenvolvimento) ─────────────────
let pgClient = null;

async function getDb() {
  if (pgClient) return pgClient;
  if (!process.env.DATABASE_URL) return null;
  try {
    const { Client } = require('pg');
    pgClient = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pgClient.connect();
    await initSchema(pgClient);
    console.log('✅ PostgreSQL conectado.');
    return pgClient;
  } catch (err) {
    console.error('❌ Erro ao conectar PostgreSQL:', err.message);
    pgClient = null;
    return null;
  }
}

async function initSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      created_at BIGINT NOT NULL,
      last_login_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rooms (
      room_code TEXT PRIMARY KEY,
      room_name TEXT NOT NULL,
      created_by TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_players (
      room_code TEXT NOT NULL,
      player_id TEXT NOT NULL,
      PRIMARY KEY (room_code, player_id)
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      player_name TEXT NOT NULL,
      room_code TEXT NOT NULL,
      room_name TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      started_at BIGINT NOT NULL,
      finished_at BIGINT,
      elapsed_ms BIGINT,
      status TEXT NOT NULL DEFAULT 'running'
    );
    CREATE TABLE IF NOT EXISTS scores (
      score_id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      player_name TEXT NOT NULL,
      room_code TEXT NOT NULL,
      room_name TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      elapsed_ms BIGINT NOT NULL,
      formatted_time TEXT,
      points INT DEFAULT 0,
      errors INT DEFAULT 0,
      finished_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scores_player ON scores(player_id);
    CREATE INDEX IF NOT EXISTS idx_scores_room ON scores(room_code);
    CREATE INDEX IF NOT EXISTS idx_scores_phase ON scores(phase_id);
  `);
}

// ── Fallback: banco JSON local (sem DATABASE_URL) ─────────────────────────
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, usersByEmail: {}, rooms: {}, runs: {}, scores: [] }, null, 2));
  }
}
function readJsonDb() {
  ensureDb();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const p = JSON.parse(raw);
    return { users: p.users || {}, usersByEmail: p.usersByEmail || {}, rooms: p.rooms || {}, runs: p.runs || {}, scores: Array.isArray(p.scores) ? p.scores : [] };
  } catch { return { users: {}, usersByEmail: {}, rooms: {}, runs: {}, scores: [] }; }
}
function writeJsonDb(db) {
  ensureDb();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ── Utilitários ───────────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(body);
}
function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(text);
}
function safeId(prefix = '') { return `${prefix}${crypto.randomUUID()}`; }
function roomCode() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function normalizeText(v) { return String(v || '').trim(); }
function cleanEmail(e) { return normalizeText(e).toLowerCase(); }
function formatMs(ms) {
  const s = Math.max(0, Number(ms || 0));
  const m = Math.floor(s / 60000), sec = Math.floor((s % 60000) / 1000), milli = Math.floor(s % 1000);
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(milli).padStart(3,'0')}`;
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) { req.destroy(); reject(new Error('Payload muito grande.')); } });
    req.on('end', () => { if (!body) return resolve({}); try { resolve(JSON.parse(body)); } catch { reject(new Error('JSON inválido.')); } });
    req.on('error', reject);
  });
}
function leaderboardRow(score, index) {
  return {
    position: index + 1,
    playerId: score.player_id || score.playerId,
    playerName: score.player_name || score.playerName,
    username: score.player_name || score.playerName,
    roomCode: score.room_code || score.roomCode,
    roomName: score.room_name || score.roomName,
    phaseId: score.phase_id || score.phaseId,
    elapsedMs: Number(score.elapsed_ms || score.elapsedMs),
    time: formatMs(score.elapsed_ms || score.elapsedMs),
    timeUsed: Math.round(Number(score.elapsed_ms || score.elapsedMs) / 1000),
    errors: Number(score.errors || 0),
    points: Number(score.points || 0),
    finishedAt: score.finished_at || score.finishedAt
  };
}

// ── Handlers PostgreSQL ───────────────────────────────────────────────────
async function pgCreateOrGetUser(pg, username, email) {
  const u = normalizeText(username), e = cleanEmail(email);
  if (u.length < 2) return { error: 'Digite um nome com pelo menos 2 caracteres.' };
  if (!e.includes('@')) return { error: 'Digite um e-mail válido.' };
  const existing = await pg.query('SELECT * FROM users WHERE email=$1', [e]);
  if (existing.rows.length) {
    const user = existing.rows[0];
    await pg.query('UPDATE users SET username=$1, last_login_at=$2 WHERE id=$3', [u.slice(0,32), Date.now(), user.id]);
    return { user: { id: user.id, username: u.slice(0,32), email: user.email } };
  }
  const id = safeId('usr_');
  const now = Date.now();
  await pg.query('INSERT INTO users(id,username,email,created_at,last_login_at) VALUES($1,$2,$3,$4,$5)', [id, u.slice(0,32), e, now, now]);
  return { user: { id, username: u.slice(0,32), email: e } };
}

async function pgBestScores(pg, filters = {}) {
  let q = 'SELECT * FROM scores WHERE 1=1';
  const params = [];
  if (filters.roomCode) { params.push(filters.roomCode); q += ` AND room_code=$${params.length}`; }
  if (filters.phaseId)  { params.push(String(filters.phaseId)); q += ` AND phase_id=$${params.length}`; }
  const { rows } = await pg.query(q, params);
  const best = new Map();
  for (const row of rows) {
    const key = `${row.player_id}::${row.phase_id}${filters.roomCode ? '::' + row.room_code : ''}`;
    const old = best.get(key);
    if (!old || Number(row.elapsed_ms) < Number(old.elapsed_ms)) best.set(key, row);
  }
  return Array.from(best.values()).sort((a,b) => Number(a.elapsed_ms) - Number(b.elapsed_ms));
}

// ── Handler principal da API ──────────────────────────────────────────────
async function handleApi(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;
  if (method === 'OPTIONS') return sendJson(res, 200, { ok: true });

  const pg = await getDb();

  // ── Health ──
  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, status: 'online', db: pg ? 'postgres' : 'json', serverTime: Date.now() });
  }

  // ── Auth ──
  if (method === 'POST' && (pathname === '/api/auth/register' || pathname === '/api/auth/login')) {
    const body = await parseBody(req);
    if (pg) {
      const result = await pgCreateOrGetUser(pg, body.username, body.email);
      if (result.error) return sendJson(res, 400, { success: false, message: result.error });
      return sendJson(res, 200, { success: true, user: result.user });
    }
    // JSON fallback
    const db = readJsonDb();
    const u = normalizeText(body.username), e = cleanEmail(body.email);
    if (u.length < 2) return sendJson(res, 400, { success: false, message: 'Nome muito curto.' });
    if (!e.includes('@')) return sendJson(res, 400, { success: false, message: 'E-mail inválido.' });
    const existId = db.usersByEmail[e];
    if (existId && db.users[existId]) {
      db.users[existId].username = u; db.users[existId].lastLoginAt = Date.now();
      writeJsonDb(db); return sendJson(res, 200, { success: true, user: db.users[existId] });
    }
    const id = safeId('usr_'), now = Date.now();
    db.users[id] = { id, username: u.slice(0,32), email: e, createdAt: now, lastLoginAt: now };
    db.usersByEmail[e] = id; writeJsonDb(db);
    return sendJson(res, 200, { success: true, user: db.users[id] });
  }

  // ── Criar sala ──
  if (method === 'POST' && pathname === '/api/rooms') {
    const body = await parseBody(req);
    const code = roomCode();
    const name = normalizeText(body.roomName).slice(0,50) || `Sala ${code}`;
    const by = normalizeText(body.createdBy || body.playerName).slice(0,32) || 'Jogador';
    if (pg) {
      await pg.query('INSERT INTO rooms(room_code,room_name,created_by,created_at) VALUES($1,$2,$3,$4)', [code, name, by, Date.now()]);
    } else {
      const db = readJsonDb();
      db.rooms[code] = { roomCode: code, roomName: name, createdBy: by, createdAt: Date.now(), players: [] };
      writeJsonDb(db);
    }
    return sendJson(res, 201, { success: true, roomCode: code, room: { roomCode: code, roomName: name } });
  }

  // ── Entrar em sala ──
  const joinMatch = pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/join$/i);
  if (method === 'POST' && joinMatch) {
    const code = joinMatch[1].toUpperCase();
    const body = await parseBody(req);
    if (pg) {
      const room = await pg.query('SELECT * FROM rooms WHERE room_code=$1', [code]);
      if (!room.rows.length) return sendJson(res, 404, { success: false, message: 'Sala não encontrada.' });
      const result = await pgCreateOrGetUser(pg, body.username || body.playerName, body.email || `${code}-${Date.now()}@offline.local`);
      if (result.error) return sendJson(res, 400, { success: false, message: result.error });
      await pg.query('INSERT INTO room_players(room_code,player_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [code, result.user.id]);
      return sendJson(res, 200, { success: true, user: result.user, playerId: result.user.id, room: room.rows[0] });
    }
    const db = readJsonDb();
    const room = db.rooms[code];
    if (!room) return sendJson(res, 404, { success: false, message: 'Sala não encontrada.' });
    const u = normalizeText(body.username || body.playerName), e = cleanEmail(body.email || `${code}-${Date.now()}@offline.local`);
    const existId = db.usersByEmail[e];
    let user;
    if (existId && db.users[existId]) { user = db.users[existId]; user.username = u; }
    else { const id = safeId('usr_'); user = { id, username: u.slice(0,32), email: e, createdAt: Date.now(), lastLoginAt: Date.now() }; db.users[id] = user; db.usersByEmail[e] = id; }
    if (!room.players.includes(user.id)) room.players.push(user.id);
    writeJsonDb(db);
    return sendJson(res, 200, { success: true, user, playerId: user.id, room });
  }

  // ── Ler sala ──
  const roomReadMatch = pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})$/i);
  if (method === 'GET' && roomReadMatch) {
    const code = roomReadMatch[1].toUpperCase();
    if (pg) {
      const room = await pg.query('SELECT * FROM rooms WHERE room_code=$1', [code]);
      if (!room.rows.length) return sendJson(res, 404, { success: false, message: 'Sala não encontrada.' });
      const players = await pg.query('SELECT u.id, u.username FROM users u JOIN room_players rp ON u.id=rp.player_id WHERE rp.room_code=$1', [code]);
      return sendJson(res, 200, { success: true, room: { ...room.rows[0], players: players.rows } });
    }
    const db = readJsonDb();
    const room = db.rooms[code];
    if (!room) return sendJson(res, 404, { success: false, message: 'Sala não encontrada.' });
    return sendJson(res, 200, { success: true, room: { ...room, players: (room.players||[]).map(id => db.users[id]).filter(Boolean).map(u => ({ id: u.id, username: u.username })) } });
  }

  // ── Iniciar partida ──
  if (method === 'POST' && pathname === '/api/runs/start') {
    const body = await parseBody(req);
    const playerId = normalizeText(body.playerId || body.userId);
    const roomCodeVal = normalizeText(body.roomCode).toUpperCase();
    const phaseId = normalizeText(body.phaseId || body.levelIndex || body.level);
    if (pg) {
      const user = await pg.query('SELECT * FROM users WHERE id=$1', [playerId]);
      if (!user.rows.length) return sendJson(res, 404, { success: false, message: 'Jogador não encontrado.' });
      const room = await pg.query('SELECT * FROM rooms WHERE room_code=$1', [roomCodeVal]);
      if (!room.rows.length) return sendJson(res, 404, { success: false, message: 'Sala não encontrada.' });
      const runId = safeId('run_'), startedAt = Date.now();
      await pg.query('INSERT INTO runs(run_id,player_id,player_name,room_code,room_name,phase_id,started_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [runId, playerId, user.rows[0].username, roomCodeVal, room.rows[0].room_name, phaseId, startedAt, 'running']);
      await pg.query('INSERT INTO room_players(room_code,player_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [roomCodeVal, playerId]);
      return sendJson(res, 201, { success: true, runId, startedAt });
    }
    const db = readJsonDb();
    const user = db.users[playerId], room = db.rooms[roomCodeVal];
    if (!user) return sendJson(res, 404, { success: false, message: 'Jogador não encontrado.' });
    if (!room) return sendJson(res, 404, { success: false, message: 'Sala não encontrada.' });
    const runId = safeId('run_'), startedAt = Date.now();
    db.runs[runId] = { runId, playerId, playerName: user.username, roomCode: roomCodeVal, roomName: room.roomName, phaseId: String(phaseId), startedAt, finishedAt: null, elapsedMs: null, status: 'running' };
    if (!room.players.includes(playerId)) room.players.push(playerId);
    writeJsonDb(db);
    return sendJson(res, 201, { success: true, runId, startedAt });
  }

  // ── Finalizar partida ──
  if (method === 'POST' && pathname === '/api/runs/finish') {
    const body = await parseBody(req);
    const runId = normalizeText(body.runId);
    if (pg) {
      const run = await pg.query('SELECT * FROM runs WHERE run_id=$1', [runId]);
      if (!run.rows.length) return sendJson(res, 404, { success: false, message: 'Tentativa não encontrada.' });
      if (run.rows[0].status === 'finished') return sendJson(res, 409, { success: false, message: 'Já finalizada.' });
      const finishedAt = Date.now(), elapsedMs = Math.max(0, finishedAt - Number(run.rows[0].started_at));
      const points = Number(body.points) || 0, errors = Number(body.errors) || 0;
      await pg.query('UPDATE runs SET finished_at=$1, elapsed_ms=$2, status=$3 WHERE run_id=$4', [finishedAt, elapsedMs, 'finished', runId]);
      const scoreId = safeId('scr_'), r = run.rows[0];
      await pg.query('INSERT INTO scores(score_id,player_id,player_name,room_code,room_name,phase_id,elapsed_ms,formatted_time,points,errors,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [scoreId, r.player_id, r.player_name, r.room_code, r.room_name, r.phase_id, elapsedMs, formatMs(elapsedMs), points, errors, finishedAt]);
      return sendJson(res, 201, { success: true, score: leaderboardRow({ score_id: scoreId, player_id: r.player_id, player_name: r.player_name, room_code: r.room_code, room_name: r.room_name, phase_id: r.phase_id, elapsed_ms: elapsedMs, points, errors, finished_at: finishedAt }, 0) });
    }
    const db = readJsonDb();
    const run = db.runs[runId];
    if (!run) return sendJson(res, 404, { success: false, message: 'Tentativa não encontrada.' });
    if (run.status === 'finished') return sendJson(res, 409, { success: false, message: 'Já finalizada.' });
    const finishedAt = Date.now(), elapsedMs = Math.max(0, finishedAt - run.startedAt);
    run.finishedAt = finishedAt; run.elapsedMs = elapsedMs; run.status = 'finished';
    const score = { scoreId: safeId('scr_'), playerId: run.playerId, playerName: run.playerName, roomCode: run.roomCode, roomName: run.roomName, phaseId: run.phaseId, elapsedMs, formattedTime: formatMs(elapsedMs), points: Number(body.points)||0, errors: Number(body.errors)||0, finishedAt };
    db.scores.push(score); writeJsonDb(db);
    return sendJson(res, 201, { success: true, score: leaderboardRow(score, 0) });
  }

  // ── Submit legado ──
  if (method === 'POST' && pathname === '/api/sessions/submit') {
    const body = await parseBody(req);
    const playerId = normalizeText(body.userId);
    const roomCodeVal = normalizeText(body.roomCode).toUpperCase() || 'GLOBAL';
    const elapsedMs = Math.max(0, Number(body.elapsedMs || body.timeUsed || 0));
    const phaseId = String(body.phaseId || body.levelIndex || body.level || 1);
    const points = Number(body.points||0), errors = Number(body.errors||0);
    if (pg) {
      const user = await pg.query('SELECT * FROM users WHERE id=$1', [playerId]);
      if (!user.rows.length) return sendJson(res, 404, { success: false, message: 'Jogador não encontrado.' });
      let room = await pg.query('SELECT * FROM rooms WHERE room_code=$1', [roomCodeVal]);
      if (!room.rows.length) {
        await pg.query('INSERT INTO rooms(room_code,room_name,created_by,created_at) VALUES($1,$2,$3,$4)', [roomCodeVal, roomCodeVal === 'GLOBAL' ? 'Ranking Global' : `Sala ${roomCodeVal}`, 'Sistema', Date.now()]);
        room = await pg.query('SELECT * FROM rooms WHERE room_code=$1', [roomCodeVal]);
      }
      const scoreId = safeId('scr_'), finishedAt = Date.now();
      await pg.query('INSERT INTO scores(score_id,player_id,player_name,room_code,room_name,phase_id,elapsed_ms,formatted_time,points,errors,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [scoreId, playerId, user.rows[0].username, roomCodeVal, room.rows[0].room_name, phaseId, elapsedMs, formatMs(elapsedMs), points, errors, finishedAt]);
      return sendJson(res, 201, { success: true });
    }
    const db = readJsonDb();
    const user = db.users[playerId];
    if (!user) return sendJson(res, 404, { success: false, message: 'Jogador não encontrado.' });
    if (!db.rooms[roomCodeVal]) db.rooms[roomCodeVal] = { roomCode: roomCodeVal, roomName: roomCodeVal === 'GLOBAL' ? 'Ranking Global' : `Sala ${roomCodeVal}`, createdBy: 'Sistema', createdAt: Date.now(), players: [] };
    db.scores.push({ scoreId: safeId('scr_'), playerId, playerName: user.username, roomCode: roomCodeVal, roomName: db.rooms[roomCodeVal].roomName, phaseId, elapsedMs, formattedTime: formatMs(elapsedMs), points, errors, finishedAt: Date.now() });
    writeJsonDb(db);
    return sendJson(res, 201, { success: true });
  }

  // ── Leaderboard por sala/fase ──
  const lbRoomMatch = pathname.match(/^\/api\/leaderboard\/([A-Z0-9]{6})\/(.+)$/i);
  if (method === 'GET' && lbRoomMatch) {
    const code = lbRoomMatch[1].toUpperCase(), phaseId = decodeURIComponent(lbRoomMatch[2]);
    if (pg) {
      const rows = (await pgBestScores(pg, { roomCode: code, phaseId })).slice(0,50).map(leaderboardRow);
      return sendJson(res, 200, { success: true, roomCode: code, phaseId, leaderboard: rows });
    }
    const db = readJsonDb();
    const all = db.scores.filter(s => s.roomCode === code && String(s.phaseId) === String(phaseId));
    const best = new Map(); for (const s of all) { if (!best.has(s.playerId) || s.elapsedMs < best.get(s.playerId).elapsedMs) best.set(s.playerId, s); }
    const rows = Array.from(best.values()).sort((a,b) => a.elapsedMs-b.elapsedMs).slice(0,50).map((s,i) => leaderboardRow(s,i));
    return sendJson(res, 200, { success: true, roomCode: code, phaseId, leaderboard: rows });
  }

  // ── Leaderboard global ──
  if (method === 'GET' && pathname === '/api/leaderboard/global') {
    const phaseId = url.searchParams.get('phaseId') || undefined;
    if (pg) {
      const rows = (await pgBestScores(pg, { phaseId })).slice(0,50).map((r,i) => leaderboardRow(r,i));
      return sendJson(res, 200, rows);
    }
    const db = readJsonDb();
    const filtered = db.scores.filter(s => !phaseId || String(s.phaseId) === String(phaseId));
    const best = new Map(); for (const s of filtered) { if (!best.has(s.playerId) || s.elapsedMs < best.get(s.playerId).elapsedMs) best.set(s.playerId, s); }
    return sendJson(res, 200, Array.from(best.values()).sort((a,b)=>a.elapsedMs-b.elapsedMs).slice(0,50).map((s,i)=>leaderboardRow(s,i)));
  }

  // ── Leaderboard por sala agrupado ──
  if (method === 'GET' && pathname === '/api/leaderboard/bysala') {
    const phaseId = url.searchParams.get('phaseId') || undefined;
    if (pg) {
      const rows = (await pgBestScores(pg, { phaseId })).slice(0,200).map((r,i) => leaderboardRow(r,i));
      const grouped = {}; for (const r of rows) { const k = r.roomCode || 'SEM_SALA'; if (!grouped[k]) grouped[k] = []; grouped[k].push(r); }
      return sendJson(res, 200, grouped);
    }
    const db = readJsonDb();
    const filtered = db.scores.filter(s => !phaseId || String(s.phaseId) === String(phaseId));
    const best = new Map(); for (const s of filtered) { if (!best.has(s.playerId+'::'+s.roomCode) || s.elapsedMs < best.get(s.playerId+'::'+s.roomCode).elapsedMs) best.set(s.playerId+'::'+s.roomCode, s); }
    const rows = Array.from(best.values()).sort((a,b)=>a.elapsedMs-b.elapsedMs).slice(0,200).map((s,i)=>leaderboardRow(s,i));
    const grouped = {}; for (const r of rows) { const k = r.roomCode||'SEM_SALA'; if (!grouped[k]) grouped[k]=[]; grouped[k].push(r); }
    return sendJson(res, 200, grouped);
  }

  // ── Perfil do jogador ──
  const playerMatch = pathname.match(/^\/api\/players\/([^/]+)$/);
  if (method === 'GET' && playerMatch) {
    const playerId = decodeURIComponent(playerMatch[1]);
    if (pg) {
      const user = await pg.query('SELECT * FROM users WHERE id=$1', [playerId]);
      if (!user.rows.length) return sendJson(res, 404, { success: false, message: 'Jogador não encontrado.' });
      const scores = await pg.query('SELECT * FROM scores WHERE player_id=$1', [playerId]);
      const rows = scores.rows;
      const totalPoints = rows.reduce((s,r)=>s+Number(r.points),0);
      const totalErrors = rows.reduce((s,r)=>s+Number(r.errors),0);
      const avgMs = rows.length ? rows.reduce((s,r)=>s+Number(r.elapsed_ms),0)/rows.length : 0;
      const phases = new Set(rows.map(r=>r.phase_id));
      return sendJson(res, 200, { id: user.rows[0].id, username: user.rows[0].username, email: user.rows[0].email, totalPoints, totalErrors, completedLevels: phases.size, avgTime: Math.round(avgMs/1000), avgMs });
    }
    const db = readJsonDb();
    const user = db.users[playerId];
    if (!user) return sendJson(res, 404, { success: false, message: 'Jogador não encontrado.' });
    const rows = db.scores.filter(s=>s.playerId===playerId);
    return sendJson(res, 200, { id: user.id, username: user.username, email: user.email, totalPoints: rows.reduce((s,r)=>s+(r.points||0),0), totalErrors: rows.reduce((s,r)=>s+(r.errors||0),0), completedLevels: new Set(rows.map(r=>r.phaseId)).size, avgTime: Math.round((rows.length?rows.reduce((s,r)=>s+r.elapsedMs,0)/rows.length:0)/1000) });
  }

  return sendJson(res, 404, { success: false, message: 'Rota não encontrada.' });
}

// ── Servidor de arquivos estáticos ────────────────────────────────────────
function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const safePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!safePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Acesso negado.');
  fs.readFile(safePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) return sendText(res, 404, 'Não encontrado.');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d2);
      });
      return;
    }
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// ── Inicialização ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { success: false, message: err.message || 'Erro interno.' });
  }
});

server.listen(PORT, async () => {
  if (!process.env.DATABASE_URL) ensureDb();
  else await getDb();
  console.log(`🏛️  Portal de Venn rodando em http://localhost:${PORT}`);
  console.log(`💾 Banco: ${process.env.DATABASE_URL ? 'PostgreSQL' : 'JSON local (data/db.json)'}`);
});
