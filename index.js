const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const express = require('express');
const path = require('path');
const fs = require('fs');

const UPTIME_KUMA_URL = 'https://uptime-kuma-production-7c44.up.railway.app';
const STATUS_SLUG = 'stremiofr-addons';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'stremiofr2024';
const CACHE_TTL = 60 * 1000;

const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch(e) {}
  return {
    groupPosters: {
      'AIOStreams':    'https://raw.githubusercontent.com/Viren070/AIOStreams/main/packages/frontend/public/logo.png',
      'AIOMetadata':  'https://aiometadata.elfhosted.com/logo.png',
      'StremThru':    'https://i.imgur.com/vhQAnad.png',
      'Stream-Fusion':'https://i.imgur.com/jOzd3Oi.png',
      'COMET':        'https://i.imgur.com/jmVoVMu.jpeg',
    },
    hiddenMonitors: [],
    defaultPoster: 'https://i.imgur.com/8yPVxJJ.png',
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();
let cache = { data: null, ts: 0 };

async function getUptimeData() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL) return cache.data;

  const [pageRes, hbRes] = await Promise.all([
    axios.get(`${UPTIME_KUMA_URL}/api/status-page/${STATUS_SLUG}`, { headers: { Accept: 'application/json' } }),
    axios.get(`${UPTIME_KUMA_URL}/api/status-page/heartbeat/${STATUS_SLUG}`, { headers: { Accept: 'application/json' } }),
  ]);

  cache = {
    data: {
      groups: pageRes.data.publicGroupList || [],
      heartbeats: hbRes.data.heartbeatList || {},
    },
    ts: now,
  };
  return cache.data;
}

const manifest = {
  id: 'fr.stremio.status',
  version: '1.0.0',
  name: '📡 Stremio FR - Statut Des Addons',
  description: 'Statut en temps réel des addons et instances Stremio FR',
  logo: 'https://i.imgur.com/8yPVxJJ.png',
  catalogs: [{
    type: 'other',
    id: 'stremio-status',
    name: '📡 Statut des Addons',
    extra: [{ name: 'genre', isRequired: false }],
    extraSupported: ['genre'],
  }],
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

        const hbs = heartbeats[monitor.id] || [];
        const last = hbs[hbs.length - 1];
        const isUp = last ? last.status === 1 : false;
        const uptime = hbs.length ? Math.round(hbs.filter(h => h.status === 1).length / hbs.length * 10000) / 100 : 0;

        metas.push({
          id: `status-${monitor.id}`,
          type: 'other',
          name: `${isUp ? '✅' : '❌'} ${monitor.name}`,
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

const addonInterface = builder.getInterface();
const router = getRouter(addonInterface);
const app = express();
app.use(express.json());

function authMiddleware(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });
  next();
}

app.get('/', (req, res) => res.redirect('/configure'));
app.get('/configure', (req, res) => res.sendFile(path.join(__dirname, 'configure.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) res.json({ token: ADMIN_PASSWORD });
  else res.status(401).json({ error: 'Mot de passe incorrect' });
});

app.get('/api/data', async (req, res) => {
  try {
    const data = await getUptimeData();
    res.json({ ...data, cacheAge: Math.round((Date.now() - cache.ts) / 1000) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config', authMiddleware, (req, res) => res.json(loadConfig()));

app.post('/api/config', authMiddleware, (req, res) => {
  config = { ...loadConfig(), ...req.body };
  saveConfig(config);
  res.json({ ok: true });
});

app.post('/api/change-password', authMiddleware, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Mot de passe requis' });
  process.env.ADMIN_PASSWORD = password;
  res.json({ ok: true });
});

app.post('/api/cache/refresh', authMiddleware, (req, res) => {
  cache = { data: null, ts: 0 };
  res.json({ ok: true, message: 'Cache vidé' });
});

// Webhook public pour Uptime Kuma (avec clé secrète)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'stremiofr-webhook';
app.post('/webhook/refresh', (req, res) => {
  const secret = req.headers['x-webhook-secret'] || req.query.secret;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Non autorisé' });
  cache = { data: null, ts: 0 };
  console.log('🔔 Cache vidé via webhook');
  res.json({ ok: true, message: 'Cache vidé via webhook' });
});

app.use(router);

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`✅ Addon lancé sur le port ${PORT}`);
  console.log(`🌐 Configure: http://localhost:${PORT}/configure`);
  console.log(`🔧 Dashboard: http://localhost:${PORT}/dashboard`);
});
