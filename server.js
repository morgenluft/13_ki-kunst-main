require('dotenv').config(); // Lädt die Variablen aus der .env Datei

const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/generate', async (req, res) => {
    const { prompt, sketch } = req.body; // Jetzt mit sketch-Daten
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

        if (data.candidates && data.candidates[0].content.parts[0].inlineData) {
            const base64Image = data.candidates[0].content.parts[0].inlineData.data;
            return res.json({ imageBase64: base64Image });
        } 
        
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "Keine Bilddaten erhalten.";
        res.json({ result: text });

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