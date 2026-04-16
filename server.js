require('dotenv').config(); // Lädt die Variablen aus der .env Datei

const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const app = express();
const PROMPT_FILE = path.join(__dirname, 'prompt.txt');
const GALLERY_DIR = path.join(__dirname, 'gallery-data');
const GALLERY_IMAGES_DIR = path.join(__dirname, 'public', 'gallery-images');
const GALLERY_INDEX_FILE = path.join(GALLERY_DIR, 'attempts.json');
const MAX_GALLERY_ATTEMPTS = 200;
const DEFAULT_ARTISTS = [
    { name: 'Vincent van Gogh', prompt: 'Erstelle ein Bild wie von gogh' },
    { name: 'Claude Monet', prompt: 'Erstelle ein Bild im Stil von Claude Monet' },
    { name: 'Pablo Picasso', prompt: 'Erstelle ein Bild im Stil von Pablo Picasso' }
];

app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function getArtistsFromFile() {
    try {
        const content = await fs.readFile(PROMPT_FILE, 'utf8');
        const artists = content
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const parts = line.split('|');
                const name = parts[0]?.trim();
                const prompt = parts.slice(1).join('|').trim();
                if (!name || !prompt) return null;
                return { name, prompt };
            })
            .filter(Boolean);

        return artists.length > 0 ? artists : DEFAULT_ARTISTS;
    } catch {
        return DEFAULT_ARTISTS;
    }
}

app.get('/api/artists', async (_req, res) => {
    const artists = await getArtistsFromFile();
    res.json({ artists: artists.map((artist) => ({ name: artist.name })) });
});

function buildCandidateDetails(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return '';
    }

    const detailParts = [];
    const finishReasons = candidates
        .map((candidate) => candidate?.finishReason)
        .filter(Boolean);

    if (finishReasons.length > 0) {
        detailParts.push(`finishReason: ${finishReasons.join(', ')}`);
    }

    const blockedRatings = [];
    candidates.forEach((candidate, candidateIdx) => {
        const ratings = Array.isArray(candidate?.safetyRatings) ? candidate.safetyRatings : [];
        ratings.forEach((rating) => {
            if (rating?.blocked || rating?.probability === 'HIGH' || rating?.probability === 'MEDIUM') {
                blockedRatings.push(
                    `c${candidateIdx + 1}:${rating.category || 'UNKNOWN'}=${rating.probability || 'n/a'}${rating.blocked ? ' (blocked)' : ''}`
                );
            }
        });
    });

    if (blockedRatings.length > 0) {
        detailParts.push(`safety: ${blockedRatings.join('; ')}`);
    }

    return detailParts.join(' | ');
}

async function ensureGalleryStorage() {
    await fs.mkdir(GALLERY_DIR, { recursive: true });
    await fs.mkdir(GALLERY_IMAGES_DIR, { recursive: true });
    try {
        await fs.access(GALLERY_INDEX_FILE);
    } catch {
        await fs.writeFile(GALLERY_INDEX_FILE, '[]', 'utf8');
    }
}

async function loadGalleryAttempts() {
    await ensureGalleryStorage();
    try {
        const raw = await fs.readFile(GALLERY_INDEX_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function saveGalleryAttempts(attempts) {
    await ensureGalleryStorage();
    await fs.writeFile(GALLERY_INDEX_FILE, JSON.stringify(attempts, null, 2), 'utf8');
}

async function saveBase64Image(base64Data, fileName) {
    const normalized = String(base64Data || '').trim();
    if (!normalized) return null;
    const cleaned = normalized.includes(',') ? normalized.split(',').pop() : normalized;
    const filePath = path.join(GALLERY_IMAGES_DIR, fileName);
    await fs.writeFile(filePath, Buffer.from(cleaned, 'base64'));
    return `/gallery-images/${fileName}`;
}

app.post('/api/generate', async (req, res) => {
    const { sketch, artistName } = req.body;
    const artists = await getArtistsFromFile();
    const selectedArtist = artists.find((artist) => artist.name === artistName) || artists[0];
    const prompt = selectedArtist.prompt;
    const apiKey = process.env.GEMINI_API_KEY;

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType: "image/png", data: sketch } } // Die Skizze mitschicken!
                    ]
                }]
            })
        });

        const data = await response.json();
        if (!response.ok) {
            const apiError = data?.error?.message || `Gemini API Fehler (${response.status})`;
            const apiDetails = Array.isArray(data?.error?.details)
                ? data.error.details
                    .map((detail) => {
                        if (typeof detail === 'string') return detail;
                        if (detail?.reason) return detail.reason;
                        if (detail?.message) return detail.message;
                        return JSON.stringify(detail);
                    })
                    .join(' | ')
                : '';
            return res.status(response.status).json({ error: apiError, details: apiDetails });
        }

        const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
        let base64Image = null;
        let textFallback = null;

        for (const candidate of candidates) {
            const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
            for (const part of parts) {
                if (part?.inlineData?.data) {
                    base64Image = part.inlineData.data;
                    break;
                }
                if (!textFallback && part?.text) {
                    textFallback = part.text;
                }
            }
            if (base64Image) break;
        }

        if (base64Image) {
            return res.json({ imageBase64: base64Image });
        }

        const text = textFallback || "Keine Bilddaten erhalten.";
        const details = buildCandidateDetails(candidates);
        return res.status(422).json({ error: text, details });

    } catch (error) {
        console.error("Fehler im Backend:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/gallery', async (_req, res) => {
    const attempts = await loadGalleryAttempts();
    res.json({ attempts });
});

app.post('/api/gallery/attempt', async (req, res) => {
    const { sketch, results } = req.body || {};
    if (!sketch || !Array.isArray(results)) {
        return res.status(400).json({ error: 'Ungültige Gallery-Daten.' });
    }

    try {
        const now = Date.now();
        const entryId = `${now}-${Math.random().toString(36).slice(2, 8)}`;
        const sketchUrl = await saveBase64Image(sketch, `${entryId}-sketch.png`);

        const items = [];
        for (let idx = 0; idx < results.length; idx += 1) {
            const result = results[idx] || {};
            const artistName = String(result.artistName || `Bild ${idx + 1}`);
            const status = result.status === 'success' ? 'success' : 'error';
            let imageUrl = null;
            if (status === 'success' && result.imageBase64) {
                imageUrl = await saveBase64Image(result.imageBase64, `${entryId}-result-${idx + 1}.png`);
            }
            items.push({
                artistName,
                status,
                imageUrl,
                error: result.error ? String(result.error) : null
            });
        }

        const newAttempt = {
            id: entryId,
            createdAt: new Date(now).toISOString(),
            sketchUrl,
            items
        };

        const existing = await loadGalleryAttempts();
        const updated = [newAttempt, ...existing].slice(0, MAX_GALLERY_ATTEMPTS);
        await saveGalleryAttempts(updated);
        res.status(201).json({ ok: true, id: entryId });
    } catch (error) {
        console.error('Fehler beim Speichern der Gallery:', error);
        res.status(500).json({ error: 'Gallery konnte nicht gespeichert werden.' });
    }
});

const PORT = process.env.PORT || 10000;

// WICHTIG: '0.0.0.0' muss als zweites Argument hinzugefügt werden!
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT} und ist extern erreichbar.`);
});