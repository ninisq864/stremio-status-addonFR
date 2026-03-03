const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const UPTIME_KUMA_URL = 'https://uptime-kuma-production-7c44.up.railway.app';

const manifest = {
    id: 'fr.stremio.status',
    version: '1.0.0',
    name: '📡 Stremio FR - Statut Des Addons',
    description: 'Statut en temps réel des addons et instances Stremio FR',
    logo: 'https://i.imgur.com/your-logo.png',
    catalogs: [
        {
            type: 'other',
            id: 'stremio-status',
            name: '📡 Statut des Addons',
        }
    ],
    resources: ['catalog'],
    types: ['other'],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id }) => {
    try {
        const response = await axios.get(`${UPTIME_KUMA_URL}/api/status-page/stremio-addons`);
        const monitors = response.data.publicGroupList || [];

        const metas = [];

        for (const group of monitors) {
            for (const monitor of group.monitorList) {
                const isUp = monitor.status === 1;
                metas.push({
                    id: `status-${monitor.id}`,
                    type: 'other',
                    name: monitor.name,
                    poster: isUp
                        ? 'https://i.imgur.com/green-status.png'
                        : 'https://i.imgur.com/red-status.png',
                    description: isUp ? '✅ En ligne' : '❌ Hors ligne',
                    genres: [group.name],
                });
            }
        }

        return { metas };
    } catch (e) {
        return { metas: [] };
    }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
console.log('Addon lancé sur le port 7000');