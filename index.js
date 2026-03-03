const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const UPTIME_KUMA_URL = 'https://uptime-kuma-production-7c44.up.railway.app';

const GROUP_POSTERS = {
  'AIOStreams':   'https://raw.githubusercontent.com/Viren070/AIOStreams/main/packages/frontend/public/logo.png',
  'AIOMetadata': 'https://aiometadata.elfhosted.com/logo.png',
  'StremThru':   'https://i.imgur.com/vhQAnad.png',
  'COMET':       'https://i.imgur.com/jmVoVMu.jpeg',
  'StreamFusion':'https://i.imgur.com/jOzd3Oi.png',
};

const DEFAULT_POSTER = 'https://i.imgur.com/8yPVxJJ.png';

const manifest = {
    id: 'fr.stremio.status',
    version: '1.0.0',
    name: '📡 Stremio FR - Statut Des Addons',
    description: 'Statut en temps réel des addons et instances Stremio FR',
    catalogs: [
        {
            type: 'other',
            id: 'stremio-status',
            name: '📡 Statut des Addons',
            extra: [
                { name: 'genre', isRequired: false }
            ],
            extraSupported: ['genre']
        }
    ],
    resources: ['catalog'],
    types: ['other'],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    const [pageResponse, heartbeatResponse] = await Promise.all([
      axios.get(`${UPTIME_KUMA_URL}/api/status-page/stremiofr-addons`, {
        headers: { 'Accept': 'application/json' }
      }),
      axios.get(`${UPTIME_KUMA_URL}/api/status-page/heartbeat/stremiofr-addons`, {
        headers: { 'Accept': 'application/json' }
      })
    ]);

    const groups = pageResponse.data.publicGroupList || [];
    const heartbeats = heartbeatResponse.data.heartbeatList || {};
    const metas = [];

    for (const group of groups) {
      const posterKey = Object.keys(GROUP_POSTERS).find(k => group.name.includes(k));
      const groupPoster = GROUP_POSTERS[posterKey] || DEFAULT_POSTER;

      for (const monitor of group.monitorList) {
        const monitorHeartbeats = heartbeats[monitor.id] || [];
        const lastHeartbeat = monitorHeartbeats[monitorHeartbeats.length - 1];
        const isUp = lastHeartbeat ? lastHeartbeat.status === 1 : false;

        if (extra?.genre && extra.genre !== group.name) continue;

        metas.push({
          id: `status-${monitor.id}`,
          type: 'other',
          name: `${isUp ? '✅' : '❌'} ${monitor.name}`,
          poster: groupPoster,
          description: `Groupe: ${group.name}\nStatut: ${isUp ? 'En ligne 🟢' : 'Hors ligne 🔴'}`,
          genres: [group.name],
        });
      }
    }

    return { metas };
  } catch (e) {
    console.error('Erreur API:', e.message);
    return { metas: [] };
  }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
console.log('Addon lancé sur le port 7000');