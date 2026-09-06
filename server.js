/**
 * JARVIS OS - servidor Express modernizado
 *
 * Requisitos:
 *   Node.js 18+
 *   GEMINI_API_KEY=...
 *   GEMINI_MODEL=gemini-2.5-flash   (opcional)
 *
 * Para Render:
 *   El disco estándar es efímero. MEMORY_FILE solo será persistente si
 *   conectas un disco persistente o sustituyes esta capa por una base de datos.
 */

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MEMORY_FILE = process.env.MEMORY_FILE || path.join(__dirname, 'memory.json');
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_ITEMS = 20;
const MAX_SESSIONS = 1000;
const REQUEST_TIMEOUT_MS = 45_000;

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// Encabezados básicos sin añadir otra dependencia al proyecto.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self)');
  next();
});

// Límite sencillo por IP para evitar abusos accidentales del endpoint.
const rateLimit = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 20;

function allowRequest(ip) {
  const now = Date.now();
  const current = rateLimit.get(ip);

  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateLimit.set(ip, { startedAt: now, count: 1 });
    return true;
  }

  current.count += 1;
  return current.count <= RATE_MAX_REQUESTS;
}

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;

  for (const [ip, value] of rateLimit) {
    if (value.startedAt < cutoff) {
      rateLimit.delete(ip);
    }
  }
}, RATE_WINDOW_MS).unref();

function normalizeMemory(value) {
  if (!value || typeof value !== 'object' || typeof value.sessions !== 'object') {
    return { sessions: {} };
  }

  const sessions = {};

  for (const [sessionId, session] of Object.entries(value.sessions)) {
    if (!/^[a-f0-9-]{16,80}$/i.test(sessionId)) continue;
    if (!session || !Array.isArray(session.history)) continue;

    const history = session.history
      .filter((item) =>
        item &&
        (item.role === 'user' || item.role === 'model') &&
        Array.isArray(item.parts) &&
        typeof item.parts[0]?.text === 'string'
      )
      .slice(-MAX_HISTORY_ITEMS)
      .map((item) => ({
        role: item.role,
        parts: [{ text: item.parts[0].text.slice(0, MAX_MESSAGE_LENGTH) }],
      }));

    sessions[sessionId] = {
      history,
      updatedAt: Number(session.updatedAt) || Date.now(),
    };
  }

  return { sessions };
}

function loadMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      return { sessions: {} };
    }

    return normalizeMemory(
      JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'))
    );
  } catch (error) {
    console.error(
      'No se pudo leer la memoria; se iniciará vacía:',
      error.message
    );

    return { sessions: {} };
  }
}

let memory = loadMemory();
let writeQueue = Promise.resolve();

// Escritura atómica para evitar corrupción de memory.json.
function saveMemory() {
  const snapshot = JSON.stringify(memory, null, 2);
  const temporaryFile = `${MEMORY_FILE}.${process.pid}.tmp`;

  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      await fsp.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
      await fsp.writeFile(temporaryFile, snapshot, 'utf8');
      await fsp.rename(temporaryFile, MEMORY_FILE);
    });

  return writeQueue;
}

function getSession(sessionId) {
  if (!memory.sessions[sessionId]) {
    const sessionIds = Object.keys(memory.sessions);

    if (sessionIds.length >= MAX_SESSIONS) {
      const oldest = sessionIds.sort(
        (a, b) =>
          memory.sessions[a].updatedAt - memory.sessions[b].updatedAt
      )[0];

      delete memory.sessions[oldest];
    }

    memory.sessions[sessionId] = {
      history: [],
      updatedAt: Date.now(),
    };
  }

  return memory.sessions[sessionId];
}

function isValidSessionId(value) {
  return (
    typeof value === 'string' &&
    /^[a-f0-9-]{16,80}$/i.test(value)
  );
}

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

// API DE CHAT
app.post('/api/chat', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (!allowRequest(ip)) {
    return jsonError(
      res,
      429,
      'Demasiadas solicitudes. Intenta de nuevo en un minuto.'
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return jsonError(
      res,
      503,
      'El servidor no tiene configurada GEMINI_API_KEY.'
    );
  }

  const message =
    typeof req.body?.message === 'string'
      ? req.body.message.trim()
      : '';

  const sessionId = req.body?.sessionId;

  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    return jsonError(
      res,
      400,
      `El mensaje debe tener entre 1 y ${MAX_MESSAGE_LENGTH} caracteres.`
    );
  }

  if (!isValidSessionId(sessionId)) {
    return jsonError(res, 400, 'La sesión no es válida.');
  }

  const session = getSession(sessionId);

  const systemPrompt = [
    'Eres JARVIS OS, un asistente personal de inteligencia artificial avanzado.',
    'Responde en español, con tono ejecutivo, natural y directo.',
    'Tus respuestas serán leídas mediante síntesis de voz: evita tablas complejas,',
    'código innecesario y párrafos demasiado largos.',
    'Si no tienes certeza, dilo claramente. Usa información actualizada cuando sea necesario.',
  ].join(' ');

  const contents = session.history
    .slice(-MAX_HISTORY_ITEMS)
    .concat([
      {
        role: 'user',
        parts: [{ text: message }],
      },
    ]);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        MODEL
      )}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents,
          systemInstruction: {
            parts: [{ text: systemPrompt }],
          },
          tools: [{ googleSearch: {} }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 800,
          },
        }),
        signal: controller.signal,
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(
        'Gemini API:',
        response.status,
        data.error?.message || 'Error desconocido'
      );

      const status = response.status === 429 ? 429 : 502;

      return jsonError(
        res,
        status,
        status === 429
          ? 'El servicio de IA está ocupado. Intenta de nuevo en unos segundos.'
          : 'Gemini no pudo procesar la solicitud.'
      );
    }

    const reply = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || '')
      .join('')
      .trim();

    if (!reply) {
      return jsonError(
        res,
        502,
        'Gemini no devolvió una respuesta utilizable.'
      );
    }

    session.history.push(
      {
        role: 'user',
        parts: [{ text: message }],
      },
      {
        role: 'model',
        parts: [{ text: reply }],
      }
    );

    session.history = session.history.slice(-MAX_HISTORY_ITEMS);
    session.updatedAt = Date.now();

    await saveMemory();

    return res.json({ reply });
  } catch (error) {
    if (error.name === 'AbortError') {
      return jsonError(
        res,
        504,
        'La IA tardó demasiado en responder.'
      );
    }

    console.error(
      'Error de enlace con Gemini:',
      error.message
    );

    return jsonError(
      res,
      502,
      'No se pudo conectar con el servicio de IA.'
    );
  } finally {
    clearTimeout(timeout);
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
  });
});

// INTERFAZ WEB
app.get('/', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#010409">
  <title>JARVIS OS</title>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>

  <style>
    :root {
      color-scheme: dark;
      --cyan: #00f0ff;
      --green: #00ff88;
      --amber: #ffb700;
    }

    * {
      box-sizing: border-box;
      margin: 0;
    }

    body {
      min-height: 100vh;
      overflow: hidden;
      background: #010409;
      color: var(--cyan);
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      align-items: center;
      padding: clamp(24px, 6vh, 56px) 18px;
    }

    #canvas-container {
      position: fixed;
      inset: 0;
      z-index: 0;
    }

    #canvas-container canvas {
      display: block;
    }

    .ui {
      position: relative;
      z-index: 1;
      width: min(100%, 460px);
      text-align: center;
    }

    .eyebrow {
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.34em;
      opacity: 0.72;
    }

    #status {
      margin-top: 10px;
      font-size: 1.05rem;
      letter-spacing: 0.22em;
      font-weight: 900;
      text-shadow: 0 0 20px var(--cyan);
    }

    #box {
      min-height: 112px;
      margin-bottom: 12px;
      padding: 20px;
      border: 1px solid #00f0ff55;
      border-radius: 20px;
      background: #020c1bbd;
      backdrop-filter: blur(14px);
      box-shadow: 0 0 35px #00f0ff1f;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    #subtext {
      color: #e0f7fc;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    .controls {
      display: flex;
      gap: 8px;
    }

    input,
    button {
      min-height: 52px;
      border-radius: 28px;
      font: inherit;
    }

    input {
      width: 100%;
      min-width: 0;
      padding: 0 18px;
      color: #e0f7fc;
      background: #020c1bd9;
      border: 1px solid #00f0ff55;
      outline: none;
    }

    input:focus {
      border-color: var(--cyan);
      box-shadow: 0 0 15px #00f0ff33;
    }

    button {
      border: 0;
      padding: 0 20px;
      color: #001018;
      background: linear-gradient(135deg, var(--cyan), #06f);
      font-size: 0.78rem;
      font-weight: 900;
      letter-spacing: 0.12em;
      white-space: nowrap;
      cursor: pointer;
      box-shadow: 0 0 25px #00f0ff80;
    }

    button:disabled {
      cursor: wait;
      opacity: 0.55;
    }

    #voice-button {
      width: 100%;
      margin-top: 10px;
    }

    .hint {
      margin-top: 12px;
      color: #b2d9df;
      font-size: 0.75rem;
      opacity: 0.75;
    }

    @media (max-width: 420px) {
      .controls {
        flex-direction: column;
      }

      button {
        width: 100%;
      }
    }
  </style>
</head>

<body>
  <div id="canvas-container" aria-hidden="true"></div>

  <header class="ui">
    <div class="eyebrow">JARVIS SYSTEM INTERFACE</div>
    <div id="status" aria-live="polite">SISTEMA LISTO</div>
  </header>

  <main class="ui">
    <section id="box">
      <p id="subtext">
        Activa el micrófono o escribe un mensaje.
      </p>
    </section>

    <form id="chat-form" class="controls">
      <input
        id="message-input"
        maxlength="2000"
        autocomplete="off"
        placeholder="Escribe a JARVIS..."
        aria-label="Mensaje para JARVIS"
      >

      <button id="send-button" type="submit">
        ENVIAR
      </button>
    </form>

    <button id="voice-button" type="button">
      ACTIVAR VOZ
    </button>

    <p class="hint">
      La voz depende de los permisos y capacidades de tu navegador.
    </p>
  </main>

  <script>
    let scene;
    let camera;
    let renderer;
    let particleSystem;
    let state = 'IDLE';
    let busy = false;

    const count = 2800;
    const synth = window.speechSynthesis;

    const statusEl = document.getElementById('status');
    const subtextEl = document.getElementById('subtext');
    const inputEl = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');
    const voiceButton = document.getElementById('voice-button');

    const sessionKey = 'jarvis-session-id';
    let sessionId = localStorage.getItem(sessionKey);

    if (!sessionId) {
      sessionId = crypto.randomUUID();
      localStorage.setItem(sessionKey, sessionId);
    }

    function setState(next, label) {
      state = next;
      statusEl.textContent = label || next;

      if (!particleSystem) return;

      const color =
        state === 'THINKING'
          ? 0xffb700
          : state === 'SPEAKING'
            ? 0x00ff88
            : 0x00f0ff;

      particleSystem.material.color.setHex(color);
    }

    function speak(text) {
      if (!('speechSynthesis' in window)) return;

      synth.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'es-MX';
      utterance.rate = 1;

      utterance.onend = () => {
        setState('IDLE', 'SISTEMA LISTO');
      };

      synth.speak(utterance);
    }

    async function sendMessage(message) {
      if (busy || !message.trim()) return;

      busy = true;
      sendButton.disabled = true;
      voiceButton.disabled = true;
      inputEl.disabled = true;

      subtextEl.textContent = '"' + message.trim() + '"';
      setState('THINKING', 'PROCESANDO...');

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: message.trim(),
            sessionId,
          }),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            data.error || 'Error de conexión'
          );
        }

        subtextEl.textContent = data.reply;
        setState('SPEAKING', 'RESPONDIENDO...');
        speak(data.reply);
      } catch (error) {
        subtextEl.textContent =
          error.message ||
          'No se pudo completar la solicitud.';

        setState('IDLE', 'ERROR');
      } finally {
        busy = false;
        sendButton.disabled = false;
        voiceButton.disabled = false;
        inputEl.disabled = false;
      }
    }

    document
      .getElementById('chat-form')
      .addEventListener('submit', (event) => {
        event.preventDefault();

        const message = inputEl.value;
        inputEl.value = '';

        sendMessage(message);
      });

    voiceButton.addEventListener('click', () => {
      const Recognition =
        window.SpeechRecognition ||
        window.webkitSpeechRecognition;

      if (!Recognition) {
        inputEl.focus();

        subtextEl.textContent =
          'Este navegador no admite voz. Puedes escribir el mensaje.';

        return;
      }

      if (busy) return;

      const recognition = new Recognition();

      recognition.lang = 'es-MX';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        setState('LISTENING', 'ESCUCHANDO...');
      };

      recognition.onerror = (event) => {
        setState('IDLE', 'SISTEMA LISTO');

        subtextEl.textContent =
          event.error === 'not-allowed'
            ? 'Permiso de micrófono denegado.'
            : 'No se pudo escuchar. Intenta de nuevo.';
      };

      recognition.onresult = (event) => {
        sendMessage(event.results[0][0].transcript);
      };

      recognition.onend = () => {
        if (state === 'LISTENING') {
          setState('IDLE', 'SISTEMA LISTO');
        }
      };

      recognition.start();
    });

    function init3D() {
      scene = new THREE.Scene();

      camera = new THREE.PerspectiveCamera(
        60,
        innerWidth / innerHeight,
        0.1,
        1000
      );

      camera.position.z = 3.3;

      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
      });

      renderer.setPixelRatio(
        Math.min(devicePixelRatio, 2)
      );

      renderer.setSize(innerWidth, innerHeight);

      document
        .getElementById('canvas-container')
        .appendChild(renderer.domElement);

      const positions = new Float32Array(count * 3);

      for (let i = 0; i < positions.length; i += 3) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        const radius = 1.15 + (Math.random() - 0.5) * 0.18;

        positions[i] =
          radius * Math.sin(phi) * Math.cos(theta);

        positions[i + 1] =
          radius * Math.sin(phi) * Math.sin(theta);

        positions[i + 2] =
          radius * Math.cos(phi);
      }

      const geometry = new THREE.BufferGeometry();

      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(positions, 3)
      );

      particleSystem = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          size: 0.028,
          color: 0x00f0ff,
          transparent: true,
          opacity: 0.85,
        })
      );

      scene.add(particleSystem);
      animate();
    }

    function animate() {
      requestAnimationFrame(animate);

      const speed =
        state === 'THINKING'
          ? 0.045
          : state === 'SPEAKING'
            ? 0.022
            : 0.004;

      particleSystem.rotation.y += speed;
      particleSystem.rotation.x += speed * 0.5;

      renderer.render(scene, camera);
    }

    addEventListener('resize', () => {
      if (!camera || !renderer) return;

      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });

    init3D();
  </script>
</body>
</html>`);
});

app.use((_req, res) => {
  jsonError(res, 404, 'Ruta no encontrada.');
});

app.listen(PORT, () => {
  console.log(
    `JARVIS OS ejecutándose en el puerto ${PORT} con el modelo ${MODEL}`
  );
});
