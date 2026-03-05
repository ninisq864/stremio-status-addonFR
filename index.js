const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const UPTIME_KUMA_URL = 'https://uptime-kuma-production-7c44.up.railway.app';
const STATUS_SLUG = 'stremiofr-addons';
const BCRYPT_ROUNDS = 12;

// Hash du mot de passe (si ADMIN_PASSWORD_HASH existe on l'utilise, sinon on hash ADMIN_PASSWORD)
let ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const ADMIN_PASSWORD_RAW = process.env.ADMIN_PASSWORD || 'stremiofr2024';

// Au démarrage : si pas de hash, on hash le mot de passe raw
async function initPassword() {
  if (!ADMIN_PASSWORD_HASH) {
    ADMIN_PASSWORD_HASH = await bcrypt.hash(ADMIN_PASSWORD_RAW, BCRYPT_ROUNDS);
    console.log('🔐 Mot de passe hashé au démarrage');
    console.log('💡 Ajoutez cette variable dans Railway pour persister le hash:');
    console.log(`ADMIN_PASSWORD_HASH=${ADMIN_PASSWORD_HASH}`);
  }
}
// TTL dynamique — lu depuis la config GitHub
function getCacheTTL() { return (config.cacheTTL || 60) * 1000; }
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24h

// ── GITHUB CONFIG ─────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_USER = 'Ninisq864';
const GITHUB_REPO = 'stremio-status-addonFR';
const GITHUB_FILE = 'config.json';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`;

const DEFAULT_CONFIG = {
  groupPosters: {
    'AIOStreams':    'https://raw.githubusercontent.com/Viren070/AIOStreams/main/packages/frontend/public/logo.png',
    'AIOMetadata':  'https://aiometadata.elfhosted.com/logo.png',
    'StremThru':    'https://i.imgur.com/vhQAnad.png',
    'Stream-Fusion':'https://i.imgur.com/jOzd3Oi.png',
    'COMET':        'https://i.imgur.com/jmVoVMu.jpeg',
  },
  hiddenMonitors: [],
  customNames: {},
  customLinks: {},
  defaultPoster: 'https://i.imgur.com/8yPVxJJ.png',
  cacheTTL: 60,
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
    console.log('✅ Config chargée depuis GitHub');
  } catch(e) {
    if (e.response?.status === 404) {
      await saveConfigToGithub(config);
    } else {
      console.error('❌ Erreur config GitHub:', e.message);
    }
  }
}

async function saveConfigToGithub(cfg) {
  if (!GITHUB_TOKEN) return;
  try {
    const res = await axios.put(GITHUB_API, {
      message: '🔧 Update config via dashboard',
      content: Buffer.from(JSON.stringify(cfg, null, 2)).toString('base64'),
      ...(githubFileSha ? { sha: githubFileSha } : {}),
    }, {
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    githubFileSha = res.data.content.sha;
    config = cfg;
  } catch(e) {
    console.error('❌ Erreur sauvegarde GitHub:', e.message);
  }
}

function loadConfig() { return config; }
async function saveConfig(cfg) { await saveConfigToGithub(cfg); }

// ── SÉCURITÉ : JWT ────────────────────────────────────────────────────────────
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
    if (payload.exp < Date.now()) return null; // expiré
    return payload;
  } catch(e) {
    return null;
  }
}

// ── SÉCURITÉ : BRUTE FORCE ────────────────────────────────────────────────────
const loginAttempts = new Map(); // ip -> { count, lastAttempt, blockedUntil }
const MAX_ATTEMPTS = 5;
const BLOCK_DURATION = 15 * 60 * 1000; // 15 minutes
const ATTEMPT_WINDOW = 10 * 60 * 1000; // 10 minutes

function checkBruteForce(ip) {
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0, blockedUntil: 0 };

  // Bloqué ?
  if (attempts.blockedUntil > now) {
    const remainingMs = attempts.blockedUntil - now;
    const remainingMin = Math.ceil(remainingMs / 60000);
    return { blocked: true, remainingMin };
  }

  // Reset si fenêtre expirée
  if (now - attempts.lastAttempt > ATTEMPT_WINDOW) {
    loginAttempts.set(ip, { count: 0, lastAttempt: now, blockedUntil: 0 });
    return { blocked: false };
  }

  return { blocked: false, attempts: attempts.count };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0, blockedUntil: 0 };
  attempts.count += 1;
  attempts.lastAttempt = now;
  if (attempts.count >= MAX_ATTEMPTS) {
    attempts.blockedUntil = now + BLOCK_DURATION;
    console.warn(`🚫 IP bloquée: ${ip} (${MAX_ATTEMPTS} tentatives échouées)`);
  }
  loginAttempts.set(ip, attempts);
}

function resetAttempts(ip) {
  loginAttempts.delete(ip);
}

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

// ── CACHE ─────────────────────────────────────────────────────────────────────
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

// ── MANIFEST ──────────────────────────────────────────────────────────────────
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

builder.defineCatalogHandler(async ({ extra }) => {
  try {
    const { groups, heartbeats } = await getUptimeData();
    const cfg = loadConfig();
    const metas = [];
    for (const group of groups) {
      const cleanName = group.name.replace(/\n/g, '').trim();
      const posterKey = Object.keys(cfg.groupPosters).find(k => cleanName.includes(k));
      const groupPoster = cfg.groupPosters[posterKey] || cfg.defaultPoster;
      for (const monitor of group.monitorList) {
        if (cfg.hiddenMonitors.includes(monitor.id)) continue;
        if (extra?.genre && extra.genre !== cleanName) continue;
        const searchQuery = extra?.search?.toLowerCase();
        const displayNameForSearch = (cfg.customNames?.[monitor.id] || monitor.name).toLowerCase();
        if (searchQuery && !displayNameForSearch.includes(searchQuery) && !cleanName.toLowerCase().includes(searchQuery)) continue;
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
    return { metas };
  } catch (e) {
    console.error('Erreur API:', e.message);
    return { metas: [] };
  }
});

// ── EXPRESS ───────────────────────────────────────────────────────────────────
const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);
const app = express();
app.use(express.json());

// Headers de sécurité
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Rate limiting global
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

// Login sécurisé
app.post('/api/login', async (req, res) => {
  const ip = req.ip;
  const { password } = req.body;

  // Check brute force
  const bruteCheck = checkBruteForce(ip);
  if (bruteCheck.blocked) {
    return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${bruteCheck.remainingMin} minutes.` });
  }

  // Vérification bcrypt (timing-safe automatiquement)
  const isValid = await bcrypt.compare(password || '', ADMIN_PASSWORD_HASH);

  if (isValid) {
    resetAttempts(ip);
    const token = generateToken({ role: 'admin' });
    console.log(`✅ Connexion admin depuis ${ip}`);
    res.json({ token, expiresIn: SESSION_DURATION });
  } else {
    recordFailedAttempt(ip);
    const attempts = loginAttempts.get(ip);
    const remaining = MAX_ATTEMPTS - (attempts?.count || 0);
    console.warn(`⚠️ Tentative échouée depuis ${ip} (${remaining} restantes)`);
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
  console.log('🔐 Mot de passe changé');
  console.log(`💡 Nouveau hash à sauvegarder: ADMIN_PASSWORD_HASH=${ADMIN_PASSWORD_HASH}`);
  res.json({ ok: true, hash: ADMIN_PASSWORD_HASH });
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
  app.listen(PORT, () => {
    console.log(`✅ Addon lancé sur le port ${PORT}`);
    console.log(`🔧 Dashboard: http://localhost:${PORT}/dashboard`);
  });
});