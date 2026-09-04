// Carga variables de entorno desde un archivo .env en desarrollo local
// (en producción, la plataforma de hosting suele inyectarlas directamente).
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

// Node 18+ trae 'fetch' de forma nativa (global). Si se ejecuta en una
// versión anterior, se usa el paquete 'node-fetch' como respaldo.
if (typeof fetch === 'undefined') {
    global.fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'memory.json');

app.use(express.json());

// 1. MANEJO DE MEMORIA PERSISTENTE (DB JSON)
function getMemory() {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ conceptos: {}, historial: [] }));
    try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) { return { conceptos: {}, historial: [] }; }
}
function saveMemory(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

// 2. ENDPOINT CON GEMINI AI + SEARCH + MEMORIA
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensaje vacío.' });
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.json({ response: "Configura GEMINI_API_KEY en las variables del servidor." });

    const memory = getMemory();
    const contextoPrevio = Object.entries(memory.conceptos).map(([k, v]) => `${k}: ${v}`).join("\n");

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [
                    ...memory.historial.slice(-6),
                    { role: 'user', parts: [{ text: message }] }
                ],
                tools: [{ googleSearch: {} }],
                systemInstruction: {
                    parts: [{
                        text: `Eres JARVIS, un asistente IA avanzado, conciso y futurista. Responde en español en máximo 2 oraciones para ser leídas por voz. 
                        Aprende y consulta tus conocimientos previos:\n${contextoPrevio}`
                    }]
                }
            })
        });

        const data = await response.json();
        const respuestaIA = data.candidates?.[0]?.content?.parts?.[0]?.text || "No pude procesar la consulta.";

        // Guardar interacción y conceptos aprendidos
        memory.historial.push({ role: 'user', parts: [{ text: message }] });
        memory.historial.push({ role: 'model', parts: [{ text: respuestaIA }] });
        if (message.toLowerCase().includes('qué es') || message.toLowerCase().includes('concepto')) {
            const clave = message.replace(/que es|concepto|de|el|la|un|una/gi, '').trim();
            if (clave) memory.conceptos[clave] = respuestaIA;
        }
        saveMemory(memory);

        return res.json({ response: respuestaIA });
    } catch (error) {
        return res.json({ response: "Error de conexión con la inteligencia artificial." });
    }
});

// 3. INTERFAZ FRONTEND HOLOGRÁFICA 3D (THREE.JS)
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>JARVIS OS</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #020204; color: #00f0ff; font-family: system-ui, sans-serif; height: 100vh; overflow: hidden; display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; user-select: none; }
        #canvas-container { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 1; }
        #ui { position: relative; z-index: 2; text-align: center; pointer-events: none; }
        #status { font-size: 0.85rem; letter-spacing: 6px; text-transform: uppercase; text-shadow: 0 0 12px #00f0ff; opacity: 0.8; margin-top: 250px; }
    </style>
</head>
<body onclick="iniciarJARVIS()">
    <div id="canvas-container"></div>
    <div id="ui"><p id="status">TOCA PARA INICIAR SISTEMA</p></div>
    <script>
        let scene, camera, renderer, particleSystem, geometry;
        let count = 1500, estado = 'IDLE', wavePhase = 0;

        function init3D() {
            scene = new THREE.Scene();
            camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
            camera.position.z = 4;
            renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
            renderer.setSize(window.innerWidth, window.innerHeight);
            document.getElementById('canvas-container').appendChild(renderer.domElement);

            geometry = new THREE.BufferGeometry();
            let positions = new Float32Array(count * 3);
            for (let i = 0; i < count * 3; i += 3) {
                let u = Math.random(), v = Math.random();
                let theta = u * 2.0 * Math.PI, phi = Math.acos(2.0 * v - 1.0);
                let r = 1.2 + (Math.random() - 0.5) * 0.2;
                positions[i] = r * Math.sin(phi) * Math.cos(theta);
                positions[i+1] = r * Math.sin(phi) * Math.sin(theta);
                positions[i+2] = r * Math.cos(phi);
            }
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            let material = new THREE.PointsMaterial({ size: 0.035, color: 0x00f0ff, transparent: true, opacity: 0.85 });
            particleSystem = new THREE.Points(geometry, material);
            scene.add(particleSystem);
            animate();
        }

        function animate() {
            requestAnimationFrame(animate);
            particleSystem.rotation.y += (estado === 'THINKING' ? 0.03 : 0.005);
            let pos = geometry.attributes.position.array;
            wavePhase += 0.15;
            for (let i = 0; i < count * 3; i += 3) {
                if (estado === 'SPEAKING') {
                    pos[i+1] += Math.sin(wavePhase + pos[i]) * 0.008; // Efecto de cuerdas vocales
                }
            }
            geometry.attributes.position.needsUpdate = true;
            renderer.render(scene, camera);
        }

        function setEstado(e) {
            estado = e;
            document.getElementById('status').innerText = e;
            let c = particleSystem.material.color;
            if (e === 'LISTENING') c.setHex(0x00f0ff);
            else if (e === 'THINKING') c.setHex(0xffaa00);
            else if (e === 'SPEAKING') c.setHex(0x00ffaa);
            else c.setHex(0x00f0ff);
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        let recognition, isProcessing = false, iniciado = false;

        function hablar(texto, alTerminar) {
            if (!('speechSynthesis' in window)) return alTerminar && alTerminar();
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(texto);
            u.lang = 'es-MX'; u.rate = 1.0; u.pitch = 0.85;
            u.onstart = () => setEstado('SPEAKING');
            u.onend = u.onerror = () => { setEstado('LISTENING'); alTerminar && alTerminar(); };
            window.speechSynthesis.speak(u);
        }

        function escuchar() {
            if (!SpeechRecognition) return;
            if (!recognition) {
                recognition = new SpeechRecognition();
                recognition.lang = 'es-MX'; recognition.continuous = true; recognition.interimResults = false;
                recognition.onresult = async (e) => {
                    if (isProcessing) return;
                    const texto = e.results[e.resultIndex][0].transcript.trim();
                    if (texto.length > 0) {
                        isProcessing = true;
                        setEstado('THINKING');
                        try {
                            const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: texto }) });
                            const data = await res.json();
                            hablar(data.response, () => { isProcessing = false; });
                        } catch (err) { hablar("Error de conexión.", () => { isProcessing = false; }); }
                    }
                };
                recognition.onend = () => { if (!isProcessing) try { recognition.start(); } catch(e){} };
            }
            try { recognition.start(); setEstado('LISTENING'); } catch(e){}
        }

        function iniciarJARVIS() {
            if (iniciado) return;
            iniciado = true;
            init3D();
            hablar("Sistemas activados. Hola Juan Manuel.", () => escuchar());
        }
    </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`Servidor activo en el puerto ${PORT}`));
