const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { io } = require('socket.io-client');
const cookieParser = require('cookie-parser');

const UPTIME_KUMA_URL = 'https://uptime-kuma-production-7c44.up.railway.app';
const STATUS_SLUG = 'stremiofr-addons';
const BCRYPT_ROUNDS = 12;

// ── DASHBOARD SECRET URL ───────────────────────────────────────────────────────
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || crypto.randomBytes(16).toString('hex');
const DASHBOARD_PATH = `/dashboard-${DASHBOARD_SECRET}`;
const DASHBOARD_COOKIE = 'dsid';
const DASHBOARD_COOKIE_SECRET = process.env.DASHBOARD_COOKIE_SECRET || crypto.randomBytes(32).toString('hex');

const UPTIME_KUMA_USERNAME = process.env.UPTIME_KUMA_USERNAME || '';
const UPTIME_KUMA_PASSWORD = process.env.UPTIME_KUMA_PASSWORD || '';

let ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const ADMIN_PASSWORD_RAW = process.env.ADMIN_PASSWORD || '';

async function initPassword() {
  if (!ADMIN_PASSWORD_HASH) {
    ADMIN_PASSWORD_HASH = await bcrypt.hash(ADMIN_PASSWORD_RAW, BCRYPT_ROUNDS);
    console.log('🔐 Mot de passe hashé au démarrage');
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
function loadConfig() { return config; }
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
let kumaStatusPage = null;

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

  // Recevoir l'ID interne de la status page
  kumaSocket.on('statusPageList', (data) => {
    if (data) {
      const page = Object.values(data).find(p => p.slug === STATUS_SLUG);
      if (page) {
        kumaStatusPageId = page.id;
        console.log(`📄 statusPageList - ID: ${page.id}, slug: ${page.slug}`);
      }
    }
  });

  // Charger la status page au démarrage
  kumaSocket.on('connect', () => {
    setTimeout(() => kumaSocket.emit('getStatusPage', STATUS_SLUG), 2000);
  });

  kumaSocket.on('statusPage', (data) => {
    if (data) { kumaStatusPage = data; console.log('📄 Status page chargée'); }
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

// Récupère la structure actuelle de la status page depuis l'API publique
// ID interne de la status page (reçu via statusPageList event)
let kumaStatusPageId = null;

// Récupère la structure complète : ID depuis Socket.IO + groupes depuis API publique
async function fetchStatusPageStructure() {
  try {
    // Fetch les groupes depuis l'API publique (toujours à jour)
    const res = await axios.get(`${UPTIME_KUMA_URL}/api/status-page/${STATUS_SLUG}`, {
      headers: { Accept: 'application/json' }
    });
    const pageData = res.data;
    // Injecter l'ID interne si on l'a reçu via Socket.IO
    if (kumaStatusPageId) pageData.id = kumaStatusPageId;
    console.log(`📄 Status page - ID: ${pageData.id} groupes: ${pageData.publicGroupList?.length}`);
    return pageData;
  } catch(e) {
    console.error('❌ Erreur fetch status page:', e.message);
    return null;
  }
}

// Ajoute un monitor ou groupe à la status page Kuma
async function addToStatusPage(monitorId, groupName, isGroup = false) {
  try {
    console.log(`📄 addToStatusPage: monitorId=${monitorId} groupName=${groupName} isGroup=${isGroup}`);
    const pageData = await fetchStatusPageStructure();
    if (!pageData) { console.error('❌ Pas de données status page'); return false; }
    console.log(`📄 pageData.id=${pageData.id} groupes=${pageData.publicGroupList?.length}`);

    // Reconstruire publicGroupList avec la structure complète attendue par Kuma
    const publicGroupList = (pageData.publicGroupList || []).map((g, i) => ({
      id: g.id || undefined,
      name: g.name,
      weight: g.weight ?? i,
      monitorList: (g.monitorList || []).map(m => ({
        id: m.id,
        sendUrl: m.sendUrl || false,
      })),
    }));

    if (isGroup) {
      publicGroupList.push({
        name: groupName,
        weight: publicGroupList.length,
        monitorList: [],
      });
    } else {
      let targetGroup = publicGroupList.find(g =>
        g.name.replace(/\n/g,'').trim().toLowerCase() === groupName.toLowerCase()
      );
      if (!targetGroup) {
        console.warn(`⚠️ Groupe "${groupName}" non trouvé, création auto`);
        targetGroup = { name: groupName || 'Non classé', weight: publicGroupList.length, monitorList: [] };
        publicGroupList.push(targetGroup);
      }
      targetGroup.monitorList.push({ id: monitorId, sendUrl: false });
    }

    const savePayload = {
      id: pageData.id,
      slug: STATUS_SLUG,
      title: pageData.title || 'StremioFR Addons',
      description: pageData.description || '',
      icon: pageData.icon || '/icon.svg',
      theme: pageData.theme || 'dark',
      published: pageData.published !== false,
      showTags: pageData.showTags || false,
      domainNameList: pageData.domainNameList || [],
      customCSS: pageData.customCSS || '',
      footerText: pageData.footerText || '',
      showPoweredBy: pageData.showPoweredBy !== false,
      publicGroupList,
    };

    console.log('📄 saveStatusPage payload groupes:', publicGroupList.map(g => g.name + ':' + g.monitorList.length));
    // saveStatusPage est fire-and-forget dans Kuma (pas de callback)
    kumaSocket.emit('saveStatusPage', savePayload, (res) => {
      console.log('📄 saveStatusPage callback:', JSON.stringify(res));
    });
    // Attendre que Kuma traite la mise à jour
    await new Promise(r => setTimeout(r, 1500));
    cache = { data: null, ts: 0 };
    console.log('✅ Status page sauvegardée');
    return true;
  } catch(e) {
    console.error('❌ Erreur addToStatusPage:', e.message, e.stack?.split('\n')[1]);
    return false;
  }
}

// Retire un monitor de la status page
async function removeFromStatusPage(monitorId) {
  try {
    const pageData = await fetchStatusPageStructure();
    if (!pageData) return false;

    const publicGroupList = (pageData.publicGroupList || []).map(g => ({
      ...g,
      monitorList: g.monitorList.filter(m => m.id !== monitorId)
    }));

    const savePayload = {
      id: pageData.id,
      slug: STATUS_SLUG,
      title: pageData.title || 'StremioFR Addons',
      description: pageData.description || '',
      icon: pageData.icon || '/icon.svg',
      theme: pageData.theme || 'dark',
      published: pageData.published !== false,
      showTags: pageData.showTags || false,
      domainNameList: pageData.domainNameList || [],
      customCSS: pageData.customCSS || '',
      footerText: pageData.footerText || '',
      showPoweredBy: pageData.showPoweredBy !== false,
      publicGroupList,
    };

    await kumaEmit('saveStatusPage', savePayload);
    cache = { data: null, ts: 0 };
    return true;
  } catch(e) {
    console.error('❌ Erreur removeFromStatusPage:', e.message);
    return false;
  }
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
    if (!header || !body || !sig) return null;
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
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
  res.setHeader('Cache-Control', 'no-store');
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
  logo: 'https://raw.githubusercontent.com/ninisq864/stremio-status-addonFR/main/logo.png',
  catalogs: [{ type: 'other', id: 'stremio-status', name: '📡 Statut des Addons', extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false }], extraSupported: ['search', 'genre'] }],
  resources: ['catalog'],
  types: ['other'],
};

const builder = new addonBuilder(manifest);

// ── DÉCODAGE CONFIG UTILISATEUR ────────────────────────────────────────────────
function decodeUserConfig(encoded) {
  if (!encoded || encoded === 'default') return null;
  try {
    // Reconvertir base64 URL-safe en base64 standard
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '=='.slice(0, (4 - b64.length % 4) % 4);
    const raw = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return {
      monitors: raw.m || raw.monitors || [],
      groups: raw.g || raw.groups || []
    };
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
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  // HTTPS forcé — utilise req.hostname (safe avec trust proxy) au lieu de req.headers.host (injectable)
  if (req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.hostname}${req.originalUrl}`);
  }
  // Headers sécurité
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none';"
  );
  next();
});

// Rate limit global
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

// Rate limit spécifique login : 10 req/min par IP
const loginRateCounts = new Map();
function loginRateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const w = loginRateCounts.get(ip) || { count: 0, start: now };
  if (now - w.start > 60000) { w.count = 0; w.start = now; }
  w.count++;
  loginRateCounts.set(ip, w);
  if (w.count > 10) return res.status(429).json({ error: 'Trop de tentatives de connexion, réessayez dans 1 minute.' });
  next();
}

// Nettoyage périodique des Maps de rate limiting (évite fuite mémoire)
setInterval(() => {
  const now = Date.now();
  for (const [ip, w] of requestCounts) { if (now - w.start > 120000) requestCounts.delete(ip); }
  for (const [ip, w] of loginRateCounts) { if (now - w.start > 120000) loginRateCounts.delete(ip); }
  for (const [ip, a] of loginAttempts) { if (now - a.lastAttempt > BLOCK_DURATION + ATTEMPT_WINDOW) loginAttempts.delete(ip); }
}, 5 * 60 * 1000);

app.get('/', (req, res) => res.redirect('/configure'));
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, 'configure.html')));

// Ancienne URL → 404 discret
app.get('/dashboard', (req, res) => res.status(404).send('Not found'));

// Route secrète dashboard
app.get(DASHBOARD_PATH, (req, res) => {
  // Juste servir la page — le cookie est posé uniquement après login réussi
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Middleware cookie pour toutes les routes /api admin
function cookieAuthMiddleware(req, res, next) {
  const cookie = req.cookies[DASHBOARD_COOKIE];
  if (!cookie) return res.status(404).json({ error: 'Not found' });
  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(cookie), Buffer.from(DASHBOARD_COOKIE_SECRET)
    );
    if (!valid) return res.status(404).json({ error: 'Not found' });
  } catch { return res.status(404).json({ error: 'Not found' }); }
  next();
}

// Route pour récupérer l'URL secrète (affichée dans les logs au démarrage)
app.get('/api/dashboard-url', (req, res) => res.status(404).send('Not found'));

// Route manifest personnalisé
app.get('/:userConfig/manifest.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  const uc = req.params.userConfig;
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(uc)) return res.status(400).json({ error: 'Config invalide' });
  const personalManifest = {
    id: `fr.stremio.status.${uc.slice(0, 12)}`,
    version: manifest.version,
    name: '📡 Stremio FR - Statut Des Addons',
    description: 'Statut en temps réel des addons et instances Stremio FR',
    logo: manifest.logo,
    catalogs: [{ type: 'other', id: `stremio-status-${uc.slice(0, 12)}`, name: '📡 Statut des Addons', extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false }], extraSupported: ['search', 'genre'] }],
    resources: ['catalog'],
    types: ['other'],
    behaviorHints: { configurable: true, configurationRequired: false },
  };
  res.json(personalManifest);
});

// Route catalog personnalisé
app.get('/:userConfig/catalog/:type/:id.json', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  const uc = req.params.userConfig;
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(uc)) return res.status(400).json({ metas: [] });
  try {
    const userCfg = decodeUserConfig(req.params.userConfig);
    const { groups, heartbeats } = await getUptimeData();
    const cfg = loadConfig();
    let metas = buildCatalog(groups, heartbeats, cfg, userCfg);
    if (req.query.genre) metas = metas.filter(m => m.genres.includes(req.query.genre));
    if (req.query.search) metas = metas.filter(m => m.name.toLowerCase().includes(req.query.search.toLowerCase()));
    res.json({ metas });
  } catch(e) {
    console.error('Erreur catalog perso:', e.message);
    res.json({ metas: [] });
  }
});

// ── LOGS DE CONNEXION ─────────────────────────────────────────────────────────
const connectionLogs = [];
const MAX_LOGS = 100;

function logConnection(ip, success) {
  const entry = {
    ts: new Date().toISOString(),
    ip,
    success,
  };
  connectionLogs.unshift(entry);
  if (connectionLogs.length > MAX_LOGS) connectionLogs.pop();
  console.log(`${success ? '✅' : '❌'} Tentative login — IP: ${ip} — ${success ? 'Succès' : 'Échec'}`);
}

app.post('/api/login', cookieAuthMiddleware, loginRateLimit, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ip = req.ip;
  const { password } = req.body;
  const bruteCheck = checkBruteForce(ip);
  if (bruteCheck.blocked) {
    logConnection(ip, false);
    return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${bruteCheck.remainingMin} minutes.` });
  }
  if (!password || typeof password !== 'string') return res.status(400).json({ error: 'Mot de passe requis' });
  const isValid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (isValid) {
    resetAttempts(ip);
    logConnection(ip, true);
    const token = generateToken({ role: 'admin' });
    // Pose le cookie de session uniquement après login réussi
    res.cookie(DASHBOARD_COOKIE, DASHBOARD_COOKIE_SECRET, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
    res.json({ token, expiresIn: SESSION_DURATION });
  } else {
    recordFailedAttempt(ip);
    logConnection(ip, false);
    const attempts = loginAttempts.get(ip);
    const remaining = MAX_ATTEMPTS - (attempts?.count || 0);
    res.status(401).json({ error: `Mot de passe incorrect. ${remaining} tentative(s) restante(s).` });
  }
});

// Route pour voir les logs de connexion depuis le dashboard
app.get('/api/connection-logs', authMiddleware, (req, res) => {
  res.json({ logs: connectionLogs });
});

app.get('/api/data', async (req, res) => {
  try {
    const data = await getUptimeData();
    res.json({ ...data, cacheAge: Math.round((Date.now() - cache.ts) / 1000) });
  } catch(e) {
    console.error('Erreur /api/data:', e.message);
    res.status(500).json({ error: 'Erreur lors de la récupération des données' });
  }
});

// Route config publique (logos uniquement, sans données sensibles)
app.get('/api/config/public', (req, res) => {
  const cfg = loadConfig();
  res.json({ groupPosters: cfg.groupPosters, defaultPoster: cfg.defaultPoster });
});

app.get('/api/config', authMiddleware, (req, res) => res.json(loadConfig()));
app.post('/api/config', authMiddleware, async (req, res) => {
  const ALLOWED_FIELDS = [
    'groupPosters', 'hiddenMonitors', 'customNames', 'customLinks',
    'defaultPoster', 'cacheTTL', 'autoIncrementVersion', 'manifestVersion',
    'hideOffline'
  ];
  const filtered = {};
  for (const key of ALLOWED_FIELDS) {
    if (key in req.body) filtered[key] = req.body[key];
  }
  // Validation des valeurs
  if (filtered.cacheTTL !== undefined) {
    const ttl = Number(filtered.cacheTTL);
    if (!Number.isFinite(ttl) || ttl < 5 || ttl > 300) return res.status(400).json({ error: 'cacheTTL doit être entre 5 et 300' });
    filtered.cacheTTL = ttl;
  }
  if (filtered.hiddenMonitors !== undefined) {
    if (!Array.isArray(filtered.hiddenMonitors) || !filtered.hiddenMonitors.every(v => Number.isInteger(v)))
      return res.status(400).json({ error: 'hiddenMonitors doit être un tableau de nombres entiers' });
  }
  if (filtered.customNames !== undefined) {
    if (typeof filtered.customNames !== 'object' || Array.isArray(filtered.customNames))
      return res.status(400).json({ error: 'customNames invalide' });
    for (const v of Object.values(filtered.customNames)) {
      if (typeof v !== 'string' || v.length > 100) return res.status(400).json({ error: 'customNames: chaque valeur doit être une chaîne de 100 caractères max' });
    }
  }
  if (filtered.customLinks !== undefined) {
    if (typeof filtered.customLinks !== 'object' || Array.isArray(filtered.customLinks))
      return res.status(400).json({ error: 'customLinks invalide' });
    for (const v of Object.values(filtered.customLinks)) {
      if (typeof v !== 'string') return res.status(400).json({ error: 'customLinks: chaque valeur doit être une chaîne' });
      if (v && v !== 'https://') { try { const u = new URL(v); if (!['http:', 'https:'].includes(u.protocol)) throw 0; } catch { return res.status(400).json({ error: `customLinks: url invalide — ${v}` }); } }
    }
  }
  if (filtered.groupPosters !== undefined) {
    if (typeof filtered.groupPosters !== 'object' || Array.isArray(filtered.groupPosters))
      return res.status(400).json({ error: 'groupPosters invalide' });
    for (const v of Object.values(filtered.groupPosters)) {
      if (typeof v !== 'string') return res.status(400).json({ error: 'groupPosters: chaque valeur doit être une URL' });
      try { const u = new URL(v); if (!['http:', 'https:'].includes(u.protocol)) throw 0; } catch { return res.status(400).json({ error: `groupPosters: url invalide — ${v}` }); }
    }
  }
  if (filtered.defaultPoster !== undefined) {
    if (typeof filtered.defaultPoster !== 'string') return res.status(400).json({ error: 'defaultPoster invalide' });
    try { const u = new URL(filtered.defaultPoster); if (!['http:', 'https:'].includes(u.protocol)) throw 0; } catch { return res.status(400).json({ error: 'defaultPoster: url invalide' }); }
  }
  const cfg = { ...loadConfig(), ...filtered };
  await saveConfig(cfg);
  res.json({ ok: true });
});
app.post('/api/cache/refresh', authMiddleware, (req, res) => {
  cache = { data: null, ts: 0 };
  res.json({ ok: true });
});
app.post('/api/change-password', authMiddleware, async (req, res) => {
  const { password } = req.body;
  if (!password || typeof password !== 'string') return res.status(400).json({ error: 'Mot de passe requis' });
  if (password.length < 12) return res.status(400).json({ error: 'Mot de passe trop court (min 12 caractères)' });
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password))
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins une minuscule, une majuscule et un chiffre' });
  ADMIN_PASSWORD_HASH = await bcrypt.hash(password, BCRYPT_ROUNDS);
  res.json({ ok: true });
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
    const { name, url, interval = 60, parent } = req.body;
    const type = (req.body.type || 'http').toLowerCase();
    const VALID_TYPES = ['http', 'https', 'tcp', 'ping', 'dns', 'group'];
    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100)
      return res.status(400).json({ error: 'name invalide (1-100 caractères)' });
    if (!VALID_TYPES.includes(type))
      return res.status(400).json({ error: `type invalide, valeurs acceptées: ${VALID_TYPES.join(', ')}` });
    if (type !== 'group') {
      if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url requise pour un monitor' });
      let parsed;
      try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'url invalide' }); }
      if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'url doit utiliser http ou https' });
    }
    const safeInterval = Math.min(Math.max(parseInt(interval) || 60, 1), 3600);
    const parentId = (parent !== undefined && parent !== null && parent !== '') ? parseInt(parent) : null;
    const payload = {
      id: null,
      name: name.trim(),
      url: url || '',
      type: type === 'https' ? 'http' : type,
      interval: safeInterval,
      active: true,
      retryInterval: safeInterval,
      maxretries: 0,
      notificationIDList: {},
      ignoreTls: false,
      upsideDown: false,
      accepted_statuscodes: ['200-299'],
      conditions: [],
      proxyId: null,
      ...(parentId !== null ? { parent: parentId } : {}),
    }
    console.log('📡 Ajout monitor Kuma:', JSON.stringify(payload));
    const result = await kumaEmit('add', payload);
    console.log('📡 Résultat add:', JSON.stringify(result));
    const newId = result?.monitorID;

    // Ajouter automatiquement à la status page
    if (newId) {
      if (type === 'group') {
        await addToStatusPage(newId, name.trim(), true);
      } else {
        let groupName = 'Non classé';
        if (parentId && kumaMonitors[parentId]) groupName = kumaMonitors[parentId].name;
        await addToStatusPage(newId, groupName, false);
      }
    }

    res.json({ ok: true, id: newId });
  } catch(e) {
    console.error('❌ Erreur ajout monitor:', e.message);
    res.status(500).json({ error: e.message });
  }
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

function parseMonitorId(str) {
  const id = parseInt(str, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

app.put('/api/kuma/monitors/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseMonitorId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID monitor invalide' });
    const monitor = kumaMonitors[id];
    if (!monitor) return res.status(404).json({ error: 'Monitor introuvable' });
    const ALLOWED = ['name', 'url', 'type', 'interval', 'active', 'parent'];
    const safeBody = {};
    for (const key of ALLOWED) {
      if (key in req.body) safeBody[key] = req.body[key];
    }
    if (safeBody.name && (typeof safeBody.name !== 'string' || safeBody.name.length > 100))
      return res.status(400).json({ error: 'name invalide' });
    if (safeBody.url) {
      let parsed;
      try { parsed = new URL(safeBody.url); } catch { return res.status(400).json({ error: 'url invalide' }); }
      if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'url doit utiliser http ou https' });
    }
    if (safeBody.interval) safeBody.interval = Math.min(Math.max(parseInt(safeBody.interval) || 60, 20), 3600);
    await kumaEmit('editMonitor', { ...monitor, ...safeBody, id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/kuma/monitors/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseMonitorId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID monitor invalide' });
    await removeFromStatusPage(id); // retirer de la status page
    await kumaEmit('deleteMonitor', id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/kuma/monitors/:id/pause', authMiddleware, async (req, res) => {
  try {
    const id = parseMonitorId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID monitor invalide' });
    await kumaEmit('pauseMonitor', id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/kuma/monitors/:id/resume', authMiddleware, async (req, res) => {
  try {
    const id = parseMonitorId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID monitor invalide' });
    await kumaEmit('resumeMonitor', id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');
app.post('/webhook/refresh', (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!secret || typeof secret !== 'string') return res.status(401).json({ error: 'Non autorisé' });
  const secretBuf = Buffer.from(secret);
  const expectedBuf = Buffer.from(WEBHOOK_SECRET);
  if (secretBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(secretBuf, expectedBuf)) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  cache = { data: null, ts: 0 };
  res.json({ ok: true });
});

app.use(router);

const PORT = process.env.PORT || 7000;
Promise.all([loadConfigFromGithub(), initPassword()]).then(() => {
  connectToKuma();
  app.listen(PORT, () => {
    console.log(`✅ Addon lancé sur le port ${PORT}`);
    console.log(`🔐 Dashboard: http://localhost:${PORT}${DASHBOARD_PATH}`);
  });
});