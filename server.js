const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Archivo local de memoria dentro del servidor
const MEMORY_FILE = path.join(__dirname, 'memory.json');

function getMemory() {
    if (!fs.existsSync(MEMORY_FILE)) {
        fs.writeFileSync(MEMORY_FILE, JSON.stringify({ history: [], concepts: {} }, null, 2));
    }
    try {
        return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    } catch (e) {
        return { history: [], concepts: {} };
    }
}

function saveMemory(data) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
}

// Endpoint para procesar la voz / texto enviado
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        return res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Render.' });
    }

    let memory = getMemory();
    memory.history.push({ role: 'user', content: message });

    // Contexto del sistema + Memoria acumulada
    const systemInstruction = `Eres JARVIS, un asistente de IA avanzado, directo, conciso y elegante. 
    Tienes acceso a búsquedas en tiempo real a través de Google. 
    Tienes memoria de conversaciones anteriores: ${JSON.stringify(memory.history.slice(-10))}.
    Responde en español de forma fluida y natural para síntesis de voz.`;

    try {
        // Llamada a la API de Gemini con Search Grounding activado
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: message }] }],
                systemInstruction: { parts: [{ text: systemInstruction }] },
                tools: [{ googleSearch: {} }] // Permite investigar clima, noticias e información en tiempo real
            })
        });

        const data = await response.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "No pude procesar la solicitud.";

        // Guardar la respuesta en la memoria
        memory.history.push({ role: 'model', content: reply });
        saveMemory(memory);

        res.json({ reply });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al conectar con Gemini API.' });
    }
});

// Interfaz Web HTML / THREE.JS
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>JARVIS OS</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { background:#020204; color:#00f0ff; font-family:-apple-system, sans-serif; height:100vh; overflow:hidden; display:flex; flex-direction:column; align-items:center; justify-content:center; }
        #canvas-container { position:absolute; top:0; left:0; width:100%; height:100%; z-index:1; }
        #ui { position:relative; z-index:2; text-align:center; pointer-events:none; padding: 20px; }
        #status { font-size:1.1rem; letter-spacing:4px; text-transform:uppercase; text-shadow:0 0 12px #00f0ff; margin-top:260px; font-weight:bold; }
        #subtext { font-size:0.85rem; color:rgba(0,240,255,0.7); margin-top:10px; max-width: 800px; }
    </style>
</head>
<body onclick="toggleEscucha()">
    <div id="canvas-container"></div>
    <div id="ui">
        <p id="status">TOCA LA PANTALLA PARA HABLAR</p>
        <p id="subtext">SISTEMA LISTO</p>
    </div>

    <script>
        let scene, camera, renderer, particleSystem, geometry;
        let count = 2000, estado = 'IDLE';
        let recognition, synth = window.speechSynthesis;

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
            particleSystem.rotation.y += (estado === 'THINKING' ? 0.04 : 0.005);
            particleSystem.rotation.x += (estado === 'THINKING' ? 0.02 : 0.002);
            renderer.render(scene, camera);
        }

        function setEstado(nuevoEstado, texto) {
            estado = nuevoEstado;
            document.getElementById('status').innerText = texto || estado;
            let c = particleSystem.material.color;
            if (estado === 'LISTENING') c.setHex(0x00f0ff);
            else if (estado === 'THINKING') c.setHex(0xffaa00);
            else if (estado === 'SPEAKING') c.setHex(0x00ffaa);
            else c.setHex(0x00f0ff);
        }

        function initSpeech() {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!SpeechRecognition) return alert("Tu navegador no soporta entrada de voz.");
            
            recognition = new SpeechRecognition();
            recognition.lang = 'es-ES';
            recognition.onstart = () => setEstado('LISTENING', 'ESCUCHANDO...');
            
            recognition.onresult = async (event) => {
                const text = event.results[0][0].transcript;
                document.getElementById('subtext').innerText = '"' + text + '"';
                setEstado('THINKING', 'INVESTIGANDO / PROCESANDO...');

                const res = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: text })
                });

                const data = await res.json();
                hablar(data.reply);
            };
        }

        function hablar(texto) {
            setEstado('SPEAKING', 'RESPONDIENDO...');
            document.getElementById('subtext').innerText = texto;
            const utterance = new SpeechSynthesisUtterance(texto);
            utterance.lang = 'es-ES';
            utterance.onend = () => setEstado('IDLE', 'TOCA PARA HABLAR NUEVAMENTE');
            synth.speak(utterance);
        }

        function toggleEscucha() {
            if (!particleSystem) init3D();
            if (!recognition) initSpeech();
            recognition.start();
        }

        init3D();
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => console.log("JARVIS corriendo en puerto " + PORT));
