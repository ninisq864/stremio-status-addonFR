const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { io } = require('socket.io-client');

const UPTIME_KUMA_URL = 'https://uptime-kuma-production-7c44.up.railway.app';
const STATUS_SLUG = 'stremiofr-addons';
const BCRYPT_ROUNDS = 12;

const UPTIME_KUMA_USERNAME = process.env.UPTIME_KUMA_USERNAME || '';
const UPTIME_KUMA_PASSWORD = process.env.UPTIME_KUMA_PASSWORD || '';

let ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const ADMIN_PASSWORD_RAW = process.env.ADMIN_PASSWORD || 'stremiofr2024';

async function initPassword() {
  if (!ADMIN_PASSWORD_HASH) {
    ADMIN_PASSWORD_HASH = await bcrypt.hash(ADMIN_PASSWORD_RAW, BCRYPT_ROUNDS);
    console.log('🔐 Mot de passe hashé au démarrage');
    console.log(`ADMIN_PASSWORD_HASH=${ADMIN_PASSWORD_HASH}`);
  }
}

function getCacheTTL() { return (config.cacheTTL || 60) * 1000; }
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_DURATION = 24 * 60 * 60 * 1000;

// ── GITHUB CONFIG ──────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_USER = 'Ninisq864';
const GITHUB_REPO = 'stremio-status-addonFR';
const GITHUB_FILE = 'config.json';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`;

const DEFAULT_CONFIG = {
  groupPosters: {
    'AIOStreams':    'https://raw.githubusercontent.com/Viren070/AIOStreams/main/packages/frontend/public/logo.png',
    'AIOMetadata':  'https://aiometadata.elfhosted.com/logo.png',
    'StremThru':    'https://emojiapi.dev/api/v1/sparkles/256.png',
    'Stream-Fusion':'https://stream-fusion.stremiofr.com/static/logo-stream-fusion.png',
    'COMET':        'https://i.imgur.com/jmVoVMu.jpeg',
    'WAStream':     'https://wastream.striho.top/static/wastream-logo.png',
  },
  hiddenMonitors: [],
  customNames: {},
  customLinks: {},
  defaultPoster: 'https://i.imgur.com/8yPVxJJ.png',
  cacheTTL: 30,
};

let config = { ...DEFAULT_CONFIG };
let githubFileSha = null;

async function loadConfigFromGithub() {
  try {
    const res = await axios.get(GITHUB_API, {
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    githubFileSha = res.data.sha;
    config = { ...DEFAULT_CONFIG, ...JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8')) };
    // Restaurer la version du manifest
    if (config.manifestVersion) manifest.version = config.manifestVersion;
    console.log('✅ Config chargée depuis GitHub');
  } catch(e) {
    if (e.response?.status === 404) await saveConfigToGithub(config);
    else console.error('❌ Erreur config GitHub:', e.message);
  }
}

async function saveConfigToGithub(cfg) {
  if (!GITHUB_TOKEN) return;
  try {
    const res = await axios.put(GITHUB_API, {
      message: '🔧 Update config via dashboard',
      content: Buffer.from(JSON.stringify(cfg, null, 2)).toString('base64'),
      ...(githubFileSha ? { sha: githubFileSha } : {}),
    }, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } });
    githubFileSha = res.data.content.sha;
    config = cfg;
  } catch(e) {
    console.error('❌ Erreur sauvegarde GitHub:', e.message);
  }
}

async function saveConfig(cfg) {
  // Auto-incrément version manifest
  if (cfg.autoIncrementVersion) {
    const parts = (cfg.manifestVersion || manifest.version).split('.').map(Number);
    parts[2] = (parts[2] || 0) + 1;
    cfg.manifestVersion = parts.join('.');
    manifest.version = cfg.manifestVersion;
    console.log(`📦 Version manifest: ${manifest.version}`);
  }
  await saveConfigToGithub(cfg);
}

// ── UPTIME KUMA SOCKET.IO ──────────────────────────────────────────────────────
let kumaSocket = null;
let kumaConnected = false;
let kumaMonitors = {};
let kumaReady = false;

function connectToKuma() {
  if (!UPTIME_KUMA_USERNAME || !UPTIME_KUMA_PASSWORD) {
    console.warn('⚠️ UPTIME_KUMA_USERNAME/PASSWORD non définis');
    return;
  }
  console.log('🔌 Connexion à Uptime Kuma...');
  kumaSocket = io(UPTIME_KUMA_URL, { transports: ['websocket'], reconnection: true, reconnectionDelay: 5000 });

  kumaSocket.on('connect', () => {
    console.log('✅ Connecté à Uptime Kuma');
    kumaConnected = true;
    kumaSocket.emit('login', { username: UPTIME_KUMA_USERNAME, password: UPTIME_KUMA_PASSWORD }, (res) => {
      if (res.ok) { console.log('✅ Auth Uptime Kuma OK'); kumaReady = true; }
      else console.error('❌ Auth Uptime Kuma échouée:', res.msg);
    });
  });

  kumaSocket.on('monitorList', (data) => {
    kumaMonitors = data;
    console.log(`📊 ${Object.keys(data).length} monitors chargés`);
  });

  kumaSocket.on('disconnect', () => {
    console.warn('⚠️ Déconnecté de Uptime Kuma');
    kumaConnected = false;
    kumaReady = false;
  });

  kumaSocket.on('connect_error', (err) => {
    console.error('❌ Erreur connexion Uptime Kuma:', err.message);
  });
}

function kumaEmit(event, data) {
  return new Promise((resolve, reject) => {
    if (!kumaSocket || !kumaReady) return reject(new Error('Non connecté à Uptime Kuma'));
    kumaSocket.emit(event, data, (res) => {
      if (res && res.ok === false) reject(new Error(res.msg || 'Erreur Kuma'));
      else resolve(res);
    });
  });
}

// ── JWT ────────────────────────────────────────────────────────────────────────
function generateToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + SESSION_DURATION })).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (sig !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch(e) { return null; }
}

// ── BRUTE FORCE ────────────────────────────────────────────────────────────────
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const BLOCK_DURATION = 15 * 60 * 1000;
const ATTEMPT_WINDOW = 10 * 60 * 1000;

function checkBruteForce(ip) {
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0, blockedUntil: 0 };
  if (attempts.blockedUntil > now) return { blocked: true, remainingMin: Math.ceil((attempts.blockedUntil - now) / 60000) };
  if (now - attempts.lastAttempt > ATTEMPT_WINDOW) { loginAttempts.set(ip, { count: 0, lastAttempt: now, blockedUntil: 0 }); return { blocked: false }; }
  return { blocked: false };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0, blockedUntil: 0 };
  attempts.count += 1; attempts.lastAttempt = now;
  if (attempts.count >= MAX_ATTEMPTS) { attempts.blockedUntil = now + BLOCK_DURATION; console.warn(`🚫 IP bloquée: ${ip}`); }
  loginAttempts.set(ip, attempts);
}

function resetAttempts(ip) { loginAttempts.delete(ip); }

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Token invalide ou expiré' });
  req.admin = payload;
  next();
}

// ── CACHE PUBLIC ───────────────────────────────────────────────────────────────
let cache = { data: null, ts: 0 };

async function getUptimeData() {
  const now = Date.now();
  if (cache.data && now - cache.ts < getCacheTTL()) return cache.data;
  const [pageRes, hbRes] = await Promise.all([
    axios.get(`${UPTIME_KUMA_URL}/api/status-page/${STATUS_SLUG}`, { headers: { Accept: 'application/json' } }),
    axios.get(`${UPTIME_KUMA_URL}/api/status-page/heartbeat/${STATUS_SLUG}`, { headers: { Accept: 'application/json' } }),
  ]);
  cache = { data: { groups: pageRes.data.publicGroupList || [], heartbeats: hbRes.data.heartbeatList || {} }, ts: now };
  return cache.data;
}

// ── MANIFEST ───────────────────────────────────────────────────────────────────
const manifest = {
  id: 'fr.stremio.status',
  version: '1.0.0',
  name: '📡 Stremio FR - Statut Des Addons',
  description: 'Statut en temps réel des addons et instances Stremio FR',
  logo: 'https://i.imgur.com/8yPVxJJ.png',
  catalogs: [{ type: 'other', id: 'stremio-status', name: '📡 Statut des Addons', extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false }], extraSupported: ['search', 'genre'] }],
  resources: ['catalog'],
  types: ['other'],
};

const builder = new addonBuilder(manifest);

// ── DÉCODAGE CONFIG UTILISATEUR ────────────────────────────────────────────────
function decodeUserConfig(encoded) {
  if (!encoded || encoded === 'default') return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch(e) { return null; }
}

function buildCatalog(groups, heartbeats, cfg, userCfg) {
  const metas = [];
  for (const group of groups) {
    const cleanName = group.name.replace(/\n/g, '').trim();
    // Filtrage par groupe si config utilisateur
    if (userCfg && userCfg.groups && userCfg.groups.length > 0) {
      if (!userCfg.groups.includes(cleanName)) continue;
    }
    const posterKey = Object.keys(cfg.groupPosters).find(k => cleanName.toLowerCase().includes(k.toLowerCase()));
    const groupPoster = cfg.groupPosters[posterKey] || cfg.defaultPoster;
    for (const monitor of group.monitorList) {
      if (cfg.hiddenMonitors.includes(monitor.id)) continue;
      // Filtrage par monitor si config utilisateur
      if (userCfg && userCfg.monitors && userCfg.monitors.length > 0) {
        if (!userCfg.monitors.includes(monitor.id)) continue;
      }
      const hbs = heartbeats[monitor.id] || [];
      const last = hbs[hbs.length - 1];
      const isUp = last ? last.status === 1 : false;
      const uptime = hbs.length ? Math.round(hbs.filter(h => h.status === 1).length / hbs.length * 10000) / 100 : 0;
      const displayName = cfg.customNames?.[monitor.id] || monitor.name;
      metas.push({
        id: `status-${monitor.id}`,
        type: 'other',
        name: `${isUp ? '✅' : '❌'} ${displayName}`,
        poster: groupPoster,
        background: groupPoster,
        description: `Groupe: ${cleanName}\nStatut: ${isUp ? 'En ligne 🟢' : 'Hors ligne 🔴'}\nUptime: ${uptime}%`,
        genres: [cleanName],
      });
    }
  }
  return metas;
}

builder.defineCatalogHandler(async ({ extra }) => {
  try {
    const { groups, heartbeats } = await getUptimeData();
    const cfg = loadConfig();
    const metas = buildCatalog(groups, heartbeats, cfg, null);
    const searchQuery = extra?.search?.toLowerCase();
    const filtered = metas.filter(m => {
      if (extra?.genre && !m.genres.includes(extra.genre)) return false;
      if (searchQuery && !m.name.toLowerCase().includes(searchQuery)) return false;
      return true;
    });
    return { metas: filtered };
  } catch (e) {
    console.error('Erreur API:', e.message);
    return { metas: [] };
  }
});

// ── EXPRESS ────────────────────────────────────────────────────────────────────
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const requestCounts = new Map();
app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const window = requestCounts.get(ip) || { count: 0, start: now };
  if (now - window.start > 60000) { window.count = 0; window.start = now; }
  window.count++;
  requestCounts.set(ip, window);
  if (window.count > 200) return res.status(429).json({ error: 'Trop de requêtes' });
  next();
});

app.get('/', (req, res) => res.redirect('/configure'));
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, 'configure.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// Route manifest personnalisé
app.get('/:userConfig/manifest.json', (req, res) => {
  const userCfg = decodeUserConfig(req.params.userConfig);
  const cfg = loadConfig();
  const personalManifest = {
    ...manifest,
    id: `fr.stremio.status.${req.params.userConfig.slice(0, 8)}`,
    name: '📡 Stremio FR - Statut Des Addons',
    behaviorHints: { configurable: true, configurationRequired: false },
  };
  res.json(personalManifest);
});

// Route catalog personnalisé
app.get('/:userConfig/catalog/:type/:id.json', async (req, res) => {
  try {
    const userCfg = decodeUserConfig(req.params.userConfig);
    const { groups, heartbeats } = await getUptimeData();
    const cfg = loadConfig();
    let metas = buildCatalog(groups, heartbeats, cfg, userCfg);
    // Filtres extra
    const extra = {};
    if (req.query.genre) extra.genre = req.query.genre;
    if (req.query.search) extra.search = req.query.search.toLowerCase();
    if (extra.genre) metas = metas.filter(m => m.genres.includes(extra.genre));
    if (extra.search) metas = metas.filter(m => m.name.toLowerCase().includes(extra.search));
    res.json({ metas });
  } catch(e) {
    console.error('Erreur catalog perso:', e.message);
    res.json({ metas: [] });
  }
});

app.post('/api/login', async (req, res) => {
  const ip = req.ip;
  const { password } = req.body;
  const bruteCheck = checkBruteForce(ip);
  if (bruteCheck.blocked) return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${bruteCheck.remainingMin} minutes.` });
  const isValid = await bcrypt.compare(password || '', ADMIN_PASSWORD_HASH);
  if (isValid) {
    resetAttempts(ip);
    const token = generateToken({ role: 'admin' });
    res.json({ token, expiresIn: SESSION_DURATION });
  } else {
    recordFailedAttempt(ip);
    const attempts = loginAttempts.get(ip);
    const remaining = MAX_ATTEMPTS - (attempts?.count || 0);
    res.status(401).json({ error: `Mot de passe incorrect. ${remaining} tentative(s) restante(s).` });
  }
});

app.get('/api/data', async (req, res) => {
  try {
    const data = await getUptimeData();
    res.json({ ...data, cacheAge: Math.round((Date.now() - cache.ts) / 1000) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/config', authMiddleware, (req, res) => res.json(loadConfig()));
app.post('/api/config', authMiddleware, async (req, res) => {
  const cfg = { ...loadConfig(), ...req.body };
  await saveConfig(cfg);
  // Déclencher webhook sortant si configuré
  if (cfg.webhookOut) {
    axios.post(cfg.webhookOut, { event: 'config_updated', ts: Date.now() })
      .catch(e => console.warn('⚠️ Webhook sortant échoué:', e.message));
  }
  res.json({ ok: true });
});
app.post('/api/cache/refresh', authMiddleware, (req, res) => {
  cache = { data: null, ts: 0 };
  res.json({ ok: true });
});
app.post('/api/change-password', authMiddleware, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (min 8 caractères)' });
  ADMIN_PASSWORD_HASH = await bcrypt.hash(password, BCRYPT_ROUNDS);
  res.json({ ok: true, hash: ADMIN_PASSWORD_HASH });
});

// ── API UPTIME KUMA ────────────────────────────────────────────────────────────
app.get('/api/kuma/status', authMiddleware, (req, res) => {
  res.json({ connected: kumaConnected, ready: kumaReady, monitorsCount: Object.keys(kumaMonitors).length });
});

app.get('/api/kuma/monitors', authMiddleware, (req, res) => {
  if (!kumaReady) return res.status(503).json({ error: 'Non connecté à Uptime Kuma' });
  const monitors = Object.values(kumaMonitors).map(m => ({
    id: m.id,
    name: m.name,
    url: m.url || '',
    type: m.type || 'http',
    active: m.active,
    interval: m.interval || 60,
  }));
  res.json({ monitors });
});

app.post('/api/kuma/monitors', authMiddleware, async (req, res) => {
  try {
    const { name, url, type = 'http', interval = 60, parent } = req.body;
    if (!name) return res.status(400).json({ error: 'name requis' });
    if (type !== 'group' && !url) return res.status(400).json({ error: 'url requise pour un monitor' });
    const payload = { name, url: url || '', type, interval, active: true };
    if (parent !== undefined && parent !== null && parent !== '') payload.parent = parseInt(parent);
    const result = await kumaEmit('add', payload);
    res.json({ ok: true, id: result.monitorID });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Réordonner les monitors (drag & drop)
app.post('/api/kuma/reorder', authMiddleware, async (req, res) => {
  try {
    const { order } = req.body; // [{ id, weight }]
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order requis' });
    await kumaEmit('changeStatusPageSlug', order);
    res.json({ ok: true });
  } catch(e) {
    // Fallback: essayer setMonitorOrder si disponible
    try {
      await kumaEmit('sortData', req.body.order);
      res.json({ ok: true });
    } catch(e2) { res.status(500).json({ error: e.message }); }
  }
});

app.put('/api/kuma/monitors/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const monitor = kumaMonitors[id];
    if (!monitor) return res.status(404).json({ error: 'Monitor introuvable' });
    await kumaEmit('editMonitor', { ...monitor, ...req.body, id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/kuma/monitors/:id', authMiddleware, async (req, res) => {
  try {
    await kumaEmit('deleteMonitor', parseInt(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/kuma/monitors/:id/pause', authMiddleware, async (req, res) => {
  try {
    await kumaEmit('pauseMonitor', parseInt(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/kuma/monitors/:id/resume', authMiddleware, async (req, res) => {
  try {
    await kumaEmit('resumeMonitor', parseInt(req.params.id));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'stremiofr-webhook';
app.post('/webhook/refresh', (req, res) => {
  const secret = req.headers['x-webhook-secret'] || req.query.secret;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Non autorisé' });
  cache = { data: null, ts: 0 };
  res.json({ ok: true });
});

app.use(router);

const PORT = process.env.PORT || 7000;
Promise.all([loadConfigFromGithub(), initPassword()]).then(() => {
  connectToKuma();
  app.listen(PORT, () => {
    console.log(`✅ Addon lancé sur le port ${PORT}`);
    console.log(`🔧 Dashboard: http://localhost:${PORT}/dashboard`);
  });
});