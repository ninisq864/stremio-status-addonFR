const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

const UPTIME_KUMA_URL = 'https://uptime-kuma-production-7c44.up.railway.app';

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
        }
    ],
    resources: ['catalog'],
    types: ['other'],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id }) => {
    try {
        const response = await axios.get(`${UPTIME_KUMA_URL}/api/status-page/stremiofr-addons`, {
            headers: { 'Accept': 'application/json' }
        });

        const groups = response.data.publicGroupList || [];
        const metas = [];

        for (const group of groups) {
            for (const monitor of group.monitorList) {
                const isUp = monitor.status === 1;
                metas.push({
                    id: `status-${monitor.id}`,
                    type: 'other',
                    name: `${isUp ? '✅' : '❌'} ${monitor.name}`,
                    poster: 'https://i.imgur.com/8yPYxJJ.png',
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