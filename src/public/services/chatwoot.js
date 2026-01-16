import fs from 'fs'
import { join, dirname, basename } from 'path' // 1. Agregamos basename
import { fileURLToPath } from 'url'
import FormData from 'form-data'
import axios from 'axios'; // O const axios = require('axios');


// --- CONFIGURACIÓN ---
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const getConfig = () => {
    try {
        const jsonPath = join(__dirname, '../json/currentKeys.json')
        const raw = fs.readFileSync(jsonPath, 'utf-8')
        return JSON.parse(raw)
    } catch (e) {
        console.error("❌ Error leyendo configuración:", e)
        return null
    }
}

// --- HELPERS ---
const deleteFile = (path) => {
    // Esperar 10 segundos antes de ejecutar el borrado
    setTimeout(() => {
        try {
            if (path && fs.existsSync(path)) {
                fs.unlinkSync(path)
                // Opcional: un log para saber que sucedió
                // console.log(`Archivo temporal eliminado: ${path}`) 
            }
        } catch (e) {
            console.error("Error borrando archivo temp:", e)
        }
    }, 10000)
}

// --- API ---

// 1. Buscar Contacto
const searchContact = async (phone) => {
    const config = getConfig()
    if (!config) return null
    try {
        const url = `${config.url}/api/v1/accounts/${config.idAcount}/contacts/search?q=+${phone}`
        const res = await fetch(url, { headers: { 'api_access_token': config.apiToken } })
        const json = await res.json()
        return (json.payload && json.payload.length > 0) ? json.payload[0] : null
    } catch (e) {
        console.error('Error SearchContact:', e)
        return null
    }
}

// 2. Crear Contacto
const createContact = async (phone) => {
    const config = getConfig()
    console.log("get config: ", config)
    try {
        const res = await fetch(`${config.url}/api/v1/accounts/${config.idAcount}/contacts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api_access_token': config.apiToken
            },
            body: JSON.stringify({
                inbox_id: config.imboxID,
                name: phone,
                phone_number: `+${phone}`
            })
        })
        const json = await res.json()
        return json.payload.contact
    } catch (e) {
        console.error('Error CreateContact:', e)
        return null
    }
}

// 3. Obtener Conversación existente
const getConversation = async (contact_id) => {
    const config = getConfig()
    try {
        const url = `${config.url}/api/v1/accounts/${config.idAcount}/contacts/${contact_id}/conversations`
        const res = await fetch(url, {
            method: "GET",
            headers: {
                'Content-Type': 'application/json',
                'api_access_token': config.apiToken
            },
        })
        const json = await res.json()

        if (json.payload && json.payload.length > 0) {
            return json.payload[0].id
        }
        return null
    } catch (e) {
        console.error('Error buscando conversación existente:', e)
        return null
    }
}

// 4. Crear Conversación (Solo si no existe una previa)
const createNewConversation = async (contactId) => {
    const config = getConfig()
    try {
        const res = await fetch(`${config.url}/api/v1/accounts/${config.idAcount}/conversations`, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json',
                'api_access_token': config.apiToken
            },
            body: JSON.stringify({
                source_id: contactId,
                inbox_id: config.imboxID,
            })
        })
        const json = await res.json()
        return json.id
    } catch (e) {
        console.error('Error creando conversación:', e)
        return null
    }
}

// 5. Enviar Mensaje de Texto
const sendMessage = async (conversationId, msg) => {
    const config = getConfig()
    try {
        await fetch(`${config.url}/api/v1/accounts/${config.idAcount}/conversations/${conversationId}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api_access_token': config.apiToken
            },
            body: JSON.stringify({
                content: msg,
                message_type: "incoming",
                private: true
            })
        })
        return true
    } catch (e) {
        console.error('Error enviando mensaje texto:', e)
        return false
    }
}

const sendMediaMessage = async (conversationId, msg, filePath, mimeType) => {
    const config = getConfig();

    // Detectar extensión (Tu lógica estaba bien)
    const mimeToExt = {
        "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
        "video/mp4": "mp4", "audio/mpeg": "mp3", "application/pdf": "pdf"
    };
    const ext = mimeToExt[mimeType] || "bin";
    const fileName = `upload_${Date.now()}.${ext}`;

    // Configurar FormData
    const form = new FormData();
    // Chatwoot permite content vacío si hay adjunto, pero null o string vacío está bien.
    if (msg) form.append("content", msg);
    form.append("message_type", "incoming");
    form.append("private", "true");

    // IMPORTANTE: Eliminamos 'file_type', Chatwoot no lo usa y puede causar error.

    const fileStream = fs.createReadStream(filePath);

    // Chatwoot (Rails) necesita "attachments[]"
    form.append("attachments[]", fileStream, { filename: fileName, contentType: mimeType });

    try {
        const url = `${config.url}/api/v1/accounts/${config.idAcount}/conversations/${conversationId}/messages`;

        // Axios maneja mejor los streams y headers de form-data
        const res = await axios.post(url, form, {
            headers: {
                'api_access_token': config.apiToken,
                ...form.getHeaders() // Esto inyecta el Boundary correcto
            },
            maxBodyLength: Infinity, // Evita errores con imágenes grandes
            maxContentLength: Infinity
        });

        return true;
    } catch (e) {
        // Axios lanza error en 400/500, captúralo aquí
        console.error("❌ Error enviando media:", e.response ? e.response.data : e.message);
        return false;
    } finally {
        // Asegúrate de que deleteFile maneje errores si el archivo está bloqueado
        try { deleteFile(filePath); } catch (err) { console.error("No se pudo borrar", err) }
    }
};


// --- LOGICA PRINCIPAL ---

// Nota: 'ext' aquí en realidad recibe el mimeType según tu app.js (ej: image/jpeg)
export const chatwootLayer = async (phone, msg, name = '', localPath = "", mimeType = "") => {
    const cleanPhone = phone.replace('+', '')

    // A. Buscar contacto
    let contact = await searchContact(cleanPhone)
    let conversationId = null

    // B. Lógica de contacto y conversación
    if (contact) {
        conversationId = await getConversation(contact.id)
    } else {
        console.log(`👤 Creando contacto nuevo: ${cleanPhone}`)
        contact = await createContact(cleanPhone)
    }

    if (!contact || !contact.id) {
        console.error('❌ Error: No se pudo gestionar el contacto')
        if (localPath) deleteFile(localPath)
        return
    }

    // D. Crear conversación si no existe
    if (!conversationId) {
        console.log('💬 Creando nueva conversación...')
        // Usamos source_id si viene del objeto contact_inboxes, o el ID directo si es recién creado
        const sourceId = contact.contact_inboxes?.[0]?.source_id || contact.id;
        conversationId = await createNewConversation(sourceId)
    }

    // E. Enviar mensaje
    if (conversationId) {
        if (localPath) {
            console.log(`📤 Enviando archivo a Chatwoot: ${localPath} (${mimeType})`)
            await sendMediaMessage(conversationId, msg, localPath, mimeType)
        } else {
            await sendMessage(conversationId, msg)
            console.log(`✅ Texto enviado a Chatwoot (Conv ID: ${conversationId})`)
        }
    }
}