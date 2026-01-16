import { join, dirname, extname } from 'path' // <--- 1. Agregado extname
import { fileURLToPath } from 'url'
import fs from 'fs'
import mime from 'mime-types' // <--- 2. Agregado mime-types
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { chatwootLayer } from './public/services/chatwoot.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PORT = process.env.PORT ?? 3007


function resolveUserJid(msg) {
  console.log(msg)
  const candidates = [
    msg?.key?.senderPn,      // ✅ Preferido (LID mappings)
    msg?.key?.senderJid,     // ✅ Variantes
    msg?.key?.participant,   // ✅ Prioridad si viene de un grupo
    msg?.key?.remoteJid      // ✅ Chat privado estándar
  ].filter(Boolean);

  for (const j of candidates) {
    let norm = j;
    if (norm.includes(':')) {
      norm = norm.split(':')[0] + '@s.whatsapp.net';
    }
    if (norm.endsWith('@s.whatsapp.net')) {
      return norm;
    }
  }
  return null;
}



// --- HELPER PARA DETECTAR TIPO DE ARCHIVO ---
const getMimeType = (file) => {
  // mime.lookup puede fallar si no detecta bien, ponemos un fallback
  return mime.lookup(file) || 'application/octet-stream';
}

// 1. FLUJO BIENVENIDA
const flowBienvenida = addKeyword(EVENTS.WELCOME)
  .addAction({ capture: false }, async (ctx, { }) => {

    const phone = resolveUserJid(ctx)
    const message = ctx.body
    const name = ctx.pushName
    console.log(phone, message, name)
    await chatwootLayer(phone, message, name)
  })

// 2. FLUJO AUDIO
const flowAudio = addKeyword(EVENTS.VOICE_NOTE)
  .addAction({ capture: false }, async (ctx, { provider }) => {
    const localPath = await provider.saveFile(ctx, { path: './src/assets' })
    const phone = resolveUserJid(ctx)
    const name = ctx.pushName
    const ext = getMimeType(localPath)
    // Nota: chatwootLayer ya maneja la lógica, solo pasamos el path
    await chatwootLayer(phone, "Nota de voz", name, localPath, ext)
  })

// 3. FLUJO MEDIA (Imagenes/Video)
const flowMedia = addKeyword(EVENTS.MEDIA)
  .addAction({ capture: false }, async (ctx, { provider }) => {
    const localPath = await provider.saveFile(ctx, { path: './src/assets' })
    const phone = resolveUserJid(ctx)
    const mensaje = ctx?.message?.imageMessage?.caption ?? ""
    const name = ctx.pushName
    const ext = getMimeType(localPath)
    await chatwootLayer(phone, mensaje, name, localPath, ext)
  })

// 4. FLUJO DOCUMENTOS
const flowDocument = addKeyword(EVENTS.DOCUMENT)
  .addAction({ capture: false }, async (ctx, { provider }) => {
    const mensaje = ctx?.message?.imageMessage?.caption ?? ""
    const localPath = await provider.saveFile(ctx, { path: './src/assets' })
    const phone = resolveUserJid(ctx)
    const name = ctx.pushName
    const ext = getMimeType(localPath)
    await chatwootLayer(phone, mensaje, name, localPath, ext)
  })

// 5. FLUJO UBICACIÓN
const flowLocation = addKeyword(EVENTS.LOCATION) // <--- Corregido a EVENTS.LOCATION
  .addAction({ capture: false }, async (ctx, { }) => {
    const lat = ctx.message?.locationMessage?.degreesLatitude;
    const long = ctx.message?.locationMessage?.degreesLongitude;
    const phone = resolveUserJid(ctx)
    const name = ctx.pushName

    if (lat && long) {
      // En ubicación NO hay archivo (localPath), así que pasamos null o no lo enviamos
      const mapLink = `https://www.google.com/maps?q=${lat},${long}`
      const message = `📍 Ubicación: ${mapLink}`
      await chatwootLayer(phone, message, name)
    }
  })




const main = async () => {
  // Aseguramos que la carpeta assets exista
  if (!fs.existsSync('./assets')) fs.mkdirSync('./assets');

  const adapterFlow = createFlow([flowBienvenida, flowAudio, flowMedia, flowDocument, flowLocation])

  const adapterProvider = createProvider(Provider, {
    version: [2, 3000, 1030817285],
  });

  const adapterDB = new Database()

  const { handleCtx, httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB,
  })

  // --- RUTAS DEL SERVIDOR ---
  adapterProvider.server.post(
    '/v1/messages',
    handleCtx(async (bot, req, res) => {
      // 1. Obtenemos datos directamente. El await en req.body no suele ser necesario si usas express/body-parser
      const body = req.body;
      const { content, conversation } = body;

      // 2. Si es nota privada, terminamos aquí
      if (body?.private) {
        return res.end('ignored: private message');
      }

      // 3. Extracción segura de Media (en una sola línea)
      // Busca attachments, si no hay, asigna null.
      const urlMedia = conversation?.messages?.[0]?.attachments?.[0]?.data_url ?? null;

      // 4. Limpieza robusta del teléfono (quita el '+' del inicio)
      const phone = conversation?.meta?.sender?.phone_number?.replace('+', '');

      try {
        // 5. Enviar mensaje
        await bot.sendMessage(phone, content, { media: urlMedia });
        return res.end('sent');
      } catch (error) {
        // console.error('Error enviando mensaje:', error);
        // Respondemos success para que Chatwoot no reintente en bucle si fue error de validación
        return res.end('error sending message');
      }
    })
  );
  adapterProvider.server.get(
    '/v1/chatwoot',
    handleCtx(async (bot, req, res) => {
      const htmlPath = join(__dirname, 'public', 'front', 'chatwoot.html')
      try {
        const html = fs.readFileSync(htmlPath, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(html)
      } catch (error) {
        res.end('Error: Archivo HTML no encontrado. Revisa la ruta public/front/')
      }
    })
  )

  adapterProvider.server.post(
    '/v1/save-chatwoot-config',
    handleCtx(async (bot, req, res) => {
      try {
        const body = req.body;
        const jsonPath = join(__dirname, 'public', 'json', 'currentKeys.json');

        // Aseguramos que el directorio exista
        const dir = dirname(jsonPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const jsonString = JSON.stringify(body, null, 2);
        fs.writeFileSync(jsonPath, jsonString, 'utf-8');
        console.log('✅ Configuración guardada en:', jsonPath);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'success', message: 'Datos guardados' }));
      } catch (error) {
        console.error('❌ Error guardando JSON:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: 'Error al escribir archivo' }));
      }
    })
  );

  adapterProvider.server.get(
    '/v1/get-chatwoot-config',
    handleCtx(async (bot, req, res) => {
      try {
        const jsonPath = join(__dirname, 'public', 'json', 'currentKeys.json');
        if (fs.existsSync(jsonPath)) {
          const rawData = fs.readFileSync(jsonPath, 'utf-8');
          const jsonData = JSON.parse(rawData);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'success', data: jsonData }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'empty', data: {} }));
        }
      } catch (error) {
        // console.error('❌ Error leyendo JSON:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: 'Error interno' }));
      }
    })
  );

  httpServer(+PORT)
}

main()