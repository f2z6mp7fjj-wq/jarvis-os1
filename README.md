# JARVIS OS

Asistente de voz con interfaz holográfica 3D (Three.js), backend en Express, integración con Gemini AI (búsqueda web incluida) y memoria persistente en un archivo JSON local.

## Estructura del proyecto

```
jarvis-project/
├── server.js        # Servidor Express + endpoint /api/chat + frontend
├── package.json      # Dependencias y scripts
├── .env.example       # Plantilla de variables de entorno
├── .gitignore
└── memory.json        # Se genera automáticamente en el primer uso
```

## Instalación

```bash
npm install
```

## Configuración

1. Copia `.env.example` a `.env`:
   ```bash
   cp .env.example .env
   ```
2. Edita `.env` y coloca tu clave real de Gemini:
   ```
   GEMINI_API_KEY=tu_api_key_real
   ```

## Ejecución

```bash
npm start
```

El servidor arrancará en `http://localhost:3000` (o el puerto definido en `PORT`).

## Notas técnicas

- El servidor usa `fetch` nativo de Node.js 18+. Si se ejecuta en una versión anterior, cae automáticamente en el paquete `node-fetch` como respaldo.
- `dotenv` carga las variables de `.env` solo en desarrollo local; en plataformas de hosting (Render, Railway, etc.) configura `GEMINI_API_KEY` directamente en las variables de entorno del servicio.
- `memory.json` almacena el historial de conversación y los "conceptos" aprendidos; no se sube al repositorio (ver `.gitignore`).
