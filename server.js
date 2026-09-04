const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const MEMORY_FILE = path.join(__dirname, 'memory.json');

function getMemory() {
    if (!fs.existsSync(MEMORY_FILE)) {
        fs.writeFileSync(MEMORY_FILE, JSON.stringify({ history: [] }, null, 2));
    }
    try {
        return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    } catch (e) {
        return { history: [] };
    }
}

function saveMemory(data) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
}

app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        return res.status(500).json({ reply: 'Falta la API Key en Render.' });
    }

    let memory = getMemory();
    memory.history.push({ role: 'user', parts: [{ text: message }] });

    const systemInstruction = "Eres JARVIS, un asistente de voz inteligente, directo, atento y con excelente memoria de conversaciones anteriores. Saluda amablemente al inicio y responde de forma concisa en español para voz.";

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: memory.history.slice(-10),
                systemInstruction: { parts: [{ text: systemInstruction }] }
            })
        });

        const data = await response.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Lo siento, no pude procesar eso.";

        memory.history.push({ role: 'model', parts: [{ text: reply }] });
        saveMemory(memory);

        res.json({ reply });
    } catch (error) {
        res.status(500).json({ reply: 'Ocurrió un error al conectar con la IA.' });
    }
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>JARVIS OS</title>
    <style>
        body { background:#0a0a10; color:#00f0ff; font-family:-apple-system, sans-serif; text-align:center; padding: 20px; display:flex; flex-direction:column; justify-content:center; height:90vh; }
        #status { font-size:1.5rem; font-weight:bold; margin-bottom:20px; text-shadow:0 0 10px #00f0ff; }
        #box { border: 2px solid #00f0ff; border-radius:15px; padding:20px; min-height:100px; box-shadow:0 0 15px rgba(0,240,255,0.3); }
        button { background:#00f0ff; color:#000; border:none; padding:18px 32px; font-size:1.2rem; border-radius:12px; font-weight:bold; margin-top:30px; }
    </style>
</head>
<body>
    <div id="status">JARVIS LISTO</div>
    <div id="box"><p id="response">Toca el botón para hablarme...</p></div>
    <div><button onclick="escuchar()">HABLAR CON JARVIS</button></div>

    <script>
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        const synth = window.speechSynthesis;

        function escuchar() {
            if (!SpeechRecognition) return alert("Abre este enlace desde Safari en tu iPhone.");
            const rec = new SpeechRecognition();
            rec.lang = 'es-MX';

            rec.onstart = () => {
                document.getElementById('status').innerText = "ESCUCHANDO...";
            };

            rec.onresult = async (e) => {
                const text = e.results[0][0].transcript;
                document.getElementById('status').innerText = "PROCESANDO...";
                document.getElementById('response').innerText = '"' + text + '"';

                try {
                    const res = await fetch('/api/chat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message: text })
                    });
                    const data = await res.json();
                    document.getElementById('response').innerText = data.reply;
                    
                    document.getElementById('status').innerText = "HABLANDO...";
                    const utt = new SpeechSynthesisUtterance(data.reply);
                    utt.lang = 'es-MX';
                    utt.onend = () => { document.getElementById('status').innerText = "JARVIS LISTO"; };
                    synth.speak(utt);
                } catch (err) {
                    document.getElementById('status').innerText = "ERROR DE CONEXIÓN";
                }
            };

            rec.start();
        }
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => console.log("Servidor arriba"));
