require('dotenv').config(); // Lädt die Variablen aus der .env Datei

const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const app = express();
const PROMPT_FILE = path.join(__dirname, 'prompt.txt');
const DEFAULT_ARTISTS = [
    { name: 'Vincent van Gogh', prompt: 'Erstelle ein Bild wie von gogh' },
    { name: 'Claude Monet', prompt: 'Erstelle ein Bild im Stil von Claude Monet' },
    { name: 'Pablo Picasso', prompt: 'Erstelle ein Bild im Stil von Pablo Picasso' }
];

app.use(express.json());
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
            return res.status(response.status).json({ error: apiError });
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
        return res.status(422).json({ error: text });

    } catch (error) {
        console.error("Fehler im Backend:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 10000;

// WICHTIG: '0.0.0.0' muss als zweites Argument hinzugefügt werden!
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT} und ist extern erreichbar.`);
});