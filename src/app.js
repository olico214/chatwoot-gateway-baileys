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

// --- HELPER PARA DETECTAR TIPO DE ARCHIVO ---
const getMimeType = (file) => {
  // mime.lookup puede fallar si no detecta bien, ponemos un fallback
  return mime.lookup(file) || 'application/octet-stream';
}

// 1. FLUJO BIENVENIDA
const flowBienvenida = addKeyword(EVENTS.WELCOME)
  .addAction({ capture: false }, async (ctx, { }) => {
    const phone = ctx.from
    const message = ctx.body
    const name = ctx.pushName
    console.log(phone, message, name)
    await chatwootLayer(phone, message, name)
  })

// 2. FLUJO AUDIO
const flowAudio = addKeyword(EVENTS.VOICE_NOTE)
  .addAction({ capture: false }, async (ctx, { provider }) => {
    const localPath = await provider.saveFile(ctx, { path: './src/assets' })
    const phone = ctx.from
    const name = ctx.pushName
    const ext = getMimeType(localPath)
    // Nota: chatwootLayer ya maneja la lógica, solo pasamos el path
    await chatwootLayer(phone, "Nota de voz", name, localPath, ext)
  })

// 3. FLUJO MEDIA (Imagenes/Video)
const flowMedia = addKeyword(EVENTS.MEDIA)
  .addAction({ capture: false }, async (ctx, { provider }) => {
    const localPath = await provider.saveFile(ctx, { path: './src/assets' })
    const phone = ctx.from
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
    const phone = ctx.from
    const name = ctx.pushName
    const ext = getMimeType(localPath)
    await chatwootLayer(phone, mensaje, name, localPath, ext)
  })

// 5. FLUJO UBICACIÓN
const flowLocation = addKeyword(EVENTS.LOCATION) // <--- Corregido a EVENTS.LOCATION
  .addAction({ capture: false }, async (ctx, { }) => {
    const lat = ctx.message?.locationMessage?.degreesLatitude;
    const long = ctx.message?.locationMessage?.degreesLongitude;
    const phone = ctx.from
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
      const data = await req.body
      const content = data.content

      let urlMedia = false;
      try {
        urlMedia = data?.conversation?.messages[0].attachments[0].data_url;
      } catch {
        urlMedia = false;
      }

      // console.log(urlMedia)
      // // return
      if (data?.private) {
        res.send('no sended')
        return
      }
      const phone = data.conversation.meta.sender.phone_number
      const number = phone.split("+")



      await bot.sendMessage(number[1], content, { media: urlMedia ?? null })
      return res.end('sended')
    })
  )

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