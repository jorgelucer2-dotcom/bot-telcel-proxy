'use strict';

// 🛡️ INFRAESTRUCTURA INTELIGENTE DE PLAYWRIGHT / RENDER:
const path = require('path');
const fs = require('fs');

const rutaLocalBrowsers = path.join(__dirname, 'node_modules', 'playwright-core', '.local-browsers');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    if (process.env.RENDER === 'true' || fs.existsSync(rutaLocalBrowsers)) {
        process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
    }
}

const http = require('http');
const https = require('https');
const os = require('os');
const { Telegraf, Markup } = require('telegraf');
const { chromium } = require('playwright');
require('dotenv').config();

// ==============================================================================
// 👥 SISTEMA PERSISTENTE DE USUARIOS / ADMINISTRACIÓN PRIVADA
// ==============================================================================
const {
    ADMIN_ID,
    esAdmin,
    estaAutorizado,
    agregarUsuario,
    eliminarUsuario,
    listarUsuarios
} = require('./modulos/usuarios');

const ADMIN_ID_STR = String(ADMIN_ID);

// ==============================================================================
// ⚙️ 1. CONFIGURACIÓN ÚNICA Y VARIABLES DE ENTORNO
// ==============================================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const PUERTO = parseInt(process.env.PORT, 10) || 10001;
const URL_TELCEL = process.env.URL_TELCEL || 'https://pay.telcel.com/package/1';
const URL_BAIT = process.env.URL_BAIT || 'https://mibait.com/recargas';
const BRIGHTDATA_BROWSER_WS = process.env.BRIGHTDATA_BROWSER_WS || process.env.PROXY || '';
const USE_LOCAL_CHROMIUM = process.env.USE_LOCAL_CHROMIUM === 'true';
const ES_HEADLESS = process.env.RENDER === 'true' || process.env.HEADLESS === 'true' || (process.platform === 'linux' && process.env.HEADLESS !== 'false');
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PUERTO}`;
const MAX_RETRIES_BAIT = 5;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '';

if (!BOT_TOKEN) {
    console.error("❌ ERROR: La variable de entorno BOT_TOKEN no está configurada.");
}

const bot = new Telegraf(BOT_TOKEN || 'DUMMY_TOKEN', { handlerTimeout: Infinity });

bot.catch((err, ctx) => {
    console.error(`[Telegram Error] Handler error para update ${ctx?.update?.update_id}:`, err.message || err);
});

// ==============================================================================
// 🛡️ PROTECCIÓN ANTI-FLOOD / SATURACIÓN (LÍMITE: 5 ACCIONES POR 10 SEGUNDOS)
// ==============================================================================
const registroAntiFlood = new Map(); // userId -> { timestamps: [], blockedUntil: 0, warned: false }
const LIMITE_ACCIONES_FLOOD = 5;
const VENTANA_TIEMPO_FLOOD_MS = 10000; // 10 segundos
const TIEMPO_BLOQUEO_FLOOD_MS = 15000; // 15 segundos de bloqueo temporal si excede

function verificarAntiFlood(userId) {
    if (!userId) return { permitido: true };
    const ahora = Date.now();
    let registro = registroAntiFlood.get(userId);

    if (!registro) {
        registro = { timestamps: [], blockedUntil: 0, warned: false };
        registroAntiFlood.set(userId, registro);
    }

    // Comprobar si el usuario está actualmente en período de bloqueo
    if (registro.blockedUntil > ahora) {
        const segundosRestantes = Math.ceil((registro.blockedUntil - ahora) / 1000);
        const debeAvisar = !registro.warned;
        registro.warned = true;
        return {
            permitido: false,
            bloqueado: true,
            segundosRestantes,
            mostrarAviso: debeAvisar
        };
    }

    // Filtrar timestamps que estén dentro de la ventana deslizante de 10s
    registro.timestamps = registro.timestamps.filter(t => ahora - t < VENTANA_TIEMPO_FLOOD_MS);
    registro.timestamps.push(ahora);

    // Si excede el límite de 5 acciones en 10 segundos -> Bloquear
    if (registro.timestamps.length > LIMITE_ACCIONES_FLOOD) {
        registro.blockedUntil = ahora + TIEMPO_BLOQUEO_FLOOD_MS;
        registro.warned = true;
        const segundosRestantes = Math.ceil(TIEMPO_BLOQUEO_FLOOD_MS / 1000);
        return {
            permitido: false,
            bloqueado: true,
            segundosRestantes,
            mostrarAviso: true
        };
    }

    // Resetear advertencia si ya no está bloqueado
    registro.warned = false;
    return { permitido: true };
}

// ==============================================================================
// 🔐 CONTROL DE ACCESO PRIVADO (SOLO USUARIOS AUTORIZADOS)
// ==============================================================================
const USUARIOS_AUTORIZADOS = new Set();

function sincronizarUsuariosAutorizados() {
    USUARIOS_AUTORIZADOS.clear();
    USUARIOS_AUTORIZADOS.add(ADMIN_ID_STR);

    for (const id of listarUsuarios()) {
        USUARIOS_AUTORIZADOS.add(String(id));
    }

    // Compatibilidad con usuarios definidos por variable de entorno.
    // Se cargan en memoria, pero los agregados desde Telegram se guardan en usuarios.json.
    if (process.env.ALLOWED_USERS) {
        for (const id of process.env.ALLOWED_USERS.split(',').map(v => v.trim()).filter(Boolean)) {
            if (/^\d+$/.test(id)) USUARIOS_AUTORIZADOS.add(id);
        }
    }
}

function autorizarUsuarioPersistente(id) {
    const resultado = agregarUsuario(id);
    sincronizarUsuariosAutorizados();
    return resultado;
}

function revocarUsuarioPersistente(id) {
    const resultado = eliminarUsuario(id);
    sincronizarUsuariosAutorizados();
    return resultado;
}

sincronizarUsuariosAutorizados();

// Middleware global de Telegraf para interceptar mensajes, comandos y callbacks
bot.use(async (ctx, next) => {
    const userId = String(ctx.from?.id || ctx.chat?.id || '');
    if (!userId) return next();

    // 1. Verificación de Acceso Privado
    if (!USUARIOS_AUTORIZADOS.has(userId)) {
        console.warn(`⛔ [Acceso Denegado] Usuario no autorizado ID: ${userId} (@${ctx.from?.username || 'Sin alias'})`);
        if (ctx.callbackQuery) {
            await ctx.answerCbQuery(`⛔ Acceso restringido. Tu ID es: ${userId}`, { show_alert: true }).catch(() => {});
        } else {
            await ctx.reply(
                `⛔ <b>Acceso Restringido (Bot Privado)</b>\n\n` +
                `Este bot está configurado en modo privado y requiere autorización previa.\n\n` +
                `🆔 <b>Tu ID de Telegram:</b> <code>${userId}</code>\n\n` +
                `<i>Pide al administrador que agregue tu ID para utilizar el servicio.</i>`,
                { parse_mode: 'HTML' }
            ).catch(() => {});
        }
        return; // Bloquea y no ejecuta ningún flujo para usuarios no autorizados
    }

    // 2. Verificación Anti-Flood
    const floodCheck = verificarAntiFlood(userId);
    if (!floodCheck.permitido) {
        console.warn(`🚫 [Anti-Flood] Usuario ${userId} bloqueado temporalmente por saturación (> ${LIMITE_ACCIONES_FLOOD} acciones en 10s)`);

        if (floodCheck.mostrarAviso) {
            try {
                if (ctx.callbackQuery) {
                    await ctx.answerCbQuery(`⚠️ Límite de acciones excedido. Espera ${floodCheck.segundosRestantes}s.`, { show_alert: true }).catch(() => {});
                } else {
                    await ctx.reply(
                        `⚠️ <b>Protección contra saturación</b>\n\nHas superado el límite de <b>${LIMITE_ACCIONES_FLOOD} acciones en 10 segundos</b>.\nPor favor espera <b>${floodCheck.segundosRestantes} segundos</b> antes de volver a enviar solicitudes.`,
                        { parse_mode: 'HTML' }
                    ).catch(() => {});
                }
            } catch (_) {}
        } else if (ctx.callbackQuery) {
            await ctx.answerCbQuery().catch(() => {});
        }
        return; // Interrumpe el flujo y no ejecuta ningún handler
    }

    return next();
});

// Limpieza periódica de memoria cada 5 minutos
setInterval(() => {
    const ahora = Date.now();
    for (const [userId, reg] of registroAntiFlood.entries()) {
        if (reg.blockedUntil < ahora && (!reg.timestamps || reg.timestamps.length === 0 || ahora - Math.max(...reg.timestamps) > 60000)) {
            registroAntiFlood.delete(userId);
        }
    }
}, 5 * 60 * 1000).unref();

// Protección global de estabilidad
process.on('uncaughtException', err => {
    console.error('💥 Excepción no controlada:', (err.message || err).toString().slice(0, 140));
});

process.on('unhandledRejection', err => {
    console.error('💥 Promesa rechazada:', (err.message || err).toString().slice(0, 140));
});

// Mapas de sesión y aislamiento total por usuario
const sesiones = new Map();
const navegadoresActivos = new Map();
const ejecucionesUsuario = new Map();
const mensajesTemporales = new Map();
const historialErroresUsuario = new Map();

// ==============================================================================
// 🧹 GESTIÓN DE MENSAJES TEMPORALES (CHAT SIEMPRE LIMPIO)
// ==============================================================================
function registrarMensajeTemporal(id, messageId) {
    if (!id || !messageId) return;
    const lista = mensajesTemporales.get(id) || [];
    if (!lista.includes(messageId)) {
        lista.push(messageId);
        mensajesTemporales.set(id, lista);
    }
}

async function limpiarMensajesTemporales(ctx, id) {
    const userId = id || ctx.chat?.id || ctx.from?.id;
    if (!userId) return;
    const lista = mensajesTemporales.get(userId) || [];
    for (const msgId of lista) {
        try {
            await ctx.telegram.deleteMessage(userId, msgId).catch(() => {});
        } catch(e) {}
    }
    mensajesTemporales.delete(userId);
}

async function enviarLimpio(ctx, texto, opciones = {}) {
    const id = ctx.chat?.id || ctx.from?.id;
    const opcionesFinales = { parse_mode: 'HTML', ...opciones };

    if (ctx.message?.message_id) {
        registrarMensajeTemporal(id, ctx.message.message_id);
    }

    // Borrar mensajes interactivos anteriores
    await limpiarMensajesTemporales(ctx, id);

    const nuevoMsg = await ctx.reply(texto, opcionesFinales).catch(err => {
        console.error(`[Telegram Usuario ${id}] Error al enviar:`, err.message || err);
        return null;
    });

    if (nuevoMsg && nuevoMsg.message_id) {
        registrarMensajeTemporal(id, nuevoMsg.message_id);
    }
    return nuevoMsg;
}

// ==============================================================================
// 🔍 1.1 DIAGNÓSTICO Y VERIFICACIÓN DE CHROMIUM / PLAYWRIGHT
// ==============================================================================
function verificarEntornoPlaywright() {
    let versionPlaywright = 'desconocida';
    try {
        versionPlaywright = require('playwright/package.json').version;
    } catch (e) {}

    console.log("==================================================");
    console.log("🦁 INICIANDO SISTEMA BOT LEÓN — INFRAESTRUCTURA");
    console.log("==================================================");
    console.log(`💻 Plataforma OS: ${process.platform} (${process.arch})`);
    console.log(`🟢 Versión Node.js: ${process.version}`);
    console.log(`🎭 Versión Playwright: ${versionPlaywright}`);
    console.log(`📁 PLAYWRIGHT_BROWSERS_PATH: ${process.env.PLAYWRIGHT_BROWSERS_PATH || 'predeterminado'}`);
    console.log(`⚙️ USE_LOCAL_CHROMIUM: ${USE_LOCAL_CHROMIUM ? 'true (Local forzado)' : 'false (Auto / CDP)'}`);
    console.log(`🌐 BRIGHTDATA_BROWSER_WS configurado: ${BRIGHTDATA_BROWSER_WS ? 'SÍ' : 'NO'}`);

    let rutaChromium = null;
    let existeChromium = false;
    try {
        rutaChromium = chromium.executablePath();
        existeChromium = fs.existsSync(rutaChromium);
        console.log(`🌐 Ruta Chromium detectada: ${rutaChromium}`);
        console.log(`✅ ¿Existe binario?: ${existeChromium ? 'SÍ (Disponible)' : 'NO (Falta instalar)'}`);
    } catch (e) {
        console.error(`⚠️ Error al calcular executablePath: ${e.message}`);
    }
    console.log("==================================================");
    return { rutaChromium, existeChromium };
}

async function smokeTestPlaywright() {
    try {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--no-first-run',
            '--lang=es-MX'
        ];
        const testBrowser = await chromium.launch({ headless: true, slowMo: 0, args, timeout: 30000 });
        const testContext = await testBrowser.newContext({ viewport: { width: 800, height: 600 } });
        const testPage = await testContext.newPage();
        await testPage.setContent('<html><body><h1>BOT LEON OK</h1></body></html>');
        await testPage.close();
        await testContext.close();
        await testBrowser.close();
        console.log("✅ [Smoke Test] Chromium local verificado con éxito.");
    } catch (err) {
        console.error("⚠️ [Smoke Test Advertencia]:", err.message || err);
    }
}

// ==============================================================================
// 🎲 2. GENERADORES DINÁMICOS ÚNICOS CON CÓDIGOS POSTALES 100% VÁLIDOS (SEPOMEX)
// ==============================================================================
const NOMBRES = [
    'Carlos', 'Alejandro', 'Miguel', 'Jose', 'Juan', 'Fernando', 'Ricardo', 'Daniel', 'Eduardo', 'Gabriel',
    'Sofia', 'Maria', 'Ana', 'Valeria', 'Camila', 'Andrea', 'Natalia', 'Daniela', 'Mariana', 'Paulina',
    'Rodrigo', 'Diego', 'Sebastian', 'Leonardo', 'Emiliano', 'Mateo', 'Javier', 'Hector', 'Arturo', 'Manuel',
    'Mauricio', 'Esteban', 'Armando', 'Sergio', 'Alberto', 'Guillermo', 'Ruben', 'Raul', 'Enrique', 'Ignacio'
];
const APELLIDOS = [
    'Hernandez', 'Garcia', 'Martinez', 'Lopez', 'Gonzalez', 'Perez', 'Rodriguez', 'Sanchez', 'Ramirez', 'Cruz',
    'Flores', 'Gomez', 'Morales', 'Vazquez', 'Reyes', 'Jimenez', 'Torres', 'Diaz', 'Gutierrez', 'Castro',
    'Ruiz', 'Alvarez', 'Mendoza', 'Juarez', 'Romero', 'Herrera', 'Medina', 'Aguilar', 'Vargas', 'Castillo',
    'Paredes', 'Salinas', 'Navarro', 'Cabrera', 'Soto', 'Delgado', 'Pena', 'Miranda', 'Rojas', 'Guerrero'
];
const DOMINIOS_CORREO = ['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com', 'icloud.com', 'proton.me', 'live.com'];

const DIRECCIONES_MEXICO_VALIDAS = [
    { cp: '01000', ciudad: 'Ciudad de México', estado: 'Ciudad de México', calle: 'Av. Insurgentes Sur 1602' },
    { cp: '03100', ciudad: 'Ciudad de México', estado: 'Ciudad de México', calle: 'Av. Universidad 1200' },
    { cp: '03810', ciudad: 'Ciudad de México', estado: 'Ciudad de México', calle: 'Calle Dakota 95' },
    { cp: '06000', ciudad: 'Ciudad de México', estado: 'Ciudad de México', calle: 'Av. Juárez 14' },
    { cp: '06600', ciudad: 'Ciudad de México', estado: 'Ciudad de México', calle: 'Paseo de la Reforma 222' },
    { cp: '06700', ciudad: 'Ciudad de México', estado: 'Ciudad de México', calle: 'Calle Álvaro Obregón 151' },
    { cp: '06100', ciudad: 'Ciudad de México', estado: 'Ciudad de México', calle: 'Av. Tamaulipas 30' },
    { cp: '06140', ciudad: 'Ciudad de México', estado: 'Ciudad de México', calle: 'Calle Amsterdam 255' },
    { cp: '11000', ciudad: 'Ciudad de México', estado: 'Ciudad de México', calle: 'Av. Prado Norte 405' },
    { cp: '11560', ciudad: 'Ciudad de México', estado: 'Ciudad de México', calle: 'Av. Homero 1425' },
    { cp: '04000', ciudad: 'Ciudad de México', estado: 'Ciudad de México', calle: 'Calle Centenario 27' },
    { cp: '14000', ciudad: 'Ciudad de México', estado: 'Ciudad de México', calle: 'Calle Madero 10' },
    { cp: '50000', ciudad: 'Toluca', estado: 'Estado de México', calle: 'Av. Hidalgo Ote 500' },
    { cp: '53100', ciudad: 'Naucalpan', estado: 'Estado de México', calle: 'Circuito Médicos 32' },
    { cp: '54000', ciudad: 'Tlalnepantla', estado: 'Estado de México', calle: 'Av. Sor Juana Inés 280' },
    { cp: '44100', ciudad: 'Guadalajara', estado: 'Jalisco', calle: 'Av. Juárez 450' },
    { cp: '44160', ciudad: 'Guadalajara', estado: 'Jalisco', calle: 'Av. Chapultepec Sur 223' },
    { cp: '44600', ciudad: 'Guadalajara', estado: 'Jalisco', calle: 'Av. Providencia 2350' },
    { cp: '45050', ciudad: 'Zapopan', estado: 'Jalisco', calle: 'Av. Mariano Otero 3450' },
    { cp: '45100', ciudad: 'Zapopan', estado: 'Jalisco', calle: 'Av. Hidalgo 151' },
    { cp: '45110', ciudad: 'Zapopan', estado: 'Jalisco', calle: 'Paseo Royal Country 4596' },
    { cp: '64000', ciudad: 'Monterrey', estado: 'Nuevo León', calle: 'Av. Constitución 400' },
    { cp: '64060', ciudad: 'Monterrey', estado: 'Nuevo León', calle: 'Calle Padre Mier 820' },
    { cp: '66220', ciudad: 'San Pedro Garza García', estado: 'Nuevo León', calle: 'Av. Vasconcelos 300' },
    { cp: '66260', ciudad: 'San Pedro Garza García', estado: 'Nuevo León', calle: 'Calzada del Valle 400' },
    { cp: '72000', ciudad: 'Puebla', estado: 'Puebla', calle: 'Av. Reforma 120' },
    { cp: '72160', ciudad: 'Puebla', estado: 'Puebla', calle: 'Av. Juárez 2108' },
    { cp: '72410', ciudad: 'Puebla', estado: 'Puebla', calle: 'Blvd. del Niño Poblano 2510' },
    { cp: '76000', ciudad: 'Querétaro', estado: 'Querétaro', calle: 'Av. Zaragoza 100' },
    { cp: '76160', ciudad: 'Querétaro', estado: 'Querétaro', calle: 'Blvd. Universitario 350' },
    { cp: '37000', ciudad: 'León', estado: 'Guanajuato', calle: 'Blvd. Adolfo López Mateos 200' },
    { cp: '97000', ciudad: 'Mérida', estado: 'Yucatán', calle: 'Calle 60 498' },
    { cp: '97100', ciudad: 'Mérida', estado: 'Yucatán', calle: 'Paseo de Montejo 450' },
    { cp: '77500', ciudad: 'Cancún', estado: 'Quintana Roo', calle: 'Av. Tulum 200' },
    { cp: '77710', ciudad: 'Playa del Carmen', estado: 'Quintana Roo', calle: 'Av. 10 Norte 150' },
    { cp: '22000', ciudad: 'Tijuana', estado: 'Baja California', calle: 'Av. Paseo de los Héroes 95' },
    { cp: '22100', ciudad: 'Tijuana', estado: 'Baja California', calle: 'Blvd. Agua Caliente 4558' },
    { cp: '62000', ciudad: 'Cuernavaca', estado: 'Morelos', calle: 'Av. Morelos 180' },
    { cp: '20000', ciudad: 'Aguascalientes', estado: 'Aguascalientes', calle: 'Av. Madero 210' },
    { cp: '78000', ciudad: 'San Luis Potosí', estado: 'San Luis Potosí', calle: 'Av. Venustiano Carranza 300' },
    { cp: '25000', ciudad: 'Saltillo', estado: 'Coahuila', calle: 'Blvd. Venustiano Carranza 1500' },
    { cp: '31000', ciudad: 'Chihuahua', estado: 'Chihuahua', calle: 'Av. Universidad 900' },
    { cp: '83000', ciudad: 'Hermosillo', estado: 'Sonora', calle: 'Blvd. Eusebio Kino 300' },
    { cp: '80000', ciudad: 'Culiacán', estado: 'Sinaloa', calle: 'Av. Álvaro Obregón 200' },
    { cp: '91700', ciudad: 'Veracruz', estado: 'Veracruz', calle: 'Av. Independencia 500' }
];

function generarDireccionValida() {
    return DIRECCIONES_MEXICO_VALIDAS[Math.floor(Math.random() * DIRECCIONES_MEXICO_VALIDAS.length)];
}

function generarCodigoPostal() {
    const dir = generarDireccionValida();
    return dir.cp;
}

function generarNombreCompleto() {
    const nom = NOMBRES[Math.floor(Math.random() * NOMBRES.length)];
    const ape1 = APELLIDOS[Math.floor(Math.random() * APELLIDOS.length)];
    const ape2 = APELLIDOS[Math.floor(Math.random() * APELLIDOS.length)];
    return { nom, ape: `${ape1} ${ape2}`, completo: `${nom} ${ape1} ${ape2}` };
}

function generarTelefonoUnico() {
    const prefijos = ['55', '56', '33', '81', '72', '22', '99', '66', '44', '77', '61', '84', '96', '74'];
    const prefijo = prefijos[Math.floor(Math.random() * prefijos.length)];
    const resto = Math.floor(10000000 + Math.random() * 90000000).toString().slice(0, 8);
    return `${prefijo}${resto}`;
}

function generarCorreoUnico(nombreObj) {
    const persona = nombreObj || generarNombreCompleto();
    const dominio = DOMINIOS_CORREO[Math.floor(Math.random() * DOMINIOS_CORREO.length)];
    const randSufijo = Math.floor(1000 + Math.random() * 9000);
    const timeSufijo = Date.now().toString().slice(-4);
    const nomLimpio = persona.nom.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const apeLimpio = persona.ape.split(' ')[0].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return `${nomLimpio}.${apeLimpio}${timeSufijo}${randSufijo}@${dominio}`;
}

// ==============================================================================
// 💳 2.2 PARSEADOR DE TARJETAS (SOPORTA AÑO DE 2 O 4 DÍGITOS)
// ==============================================================================
function parsearDatosTarjeta(texto) {
    if (!texto) return { valido: false };
    
    const partes = texto.split(/[|\s/;,]+/).map(p => p.trim()).filter(Boolean);
    
    let tarjeta = '', mes = '', anio = '', cvv = '';

    if (partes.length >= 4) {
        tarjeta = partes[0];
        mes = partes[1];
        anio = partes[2];
        cvv = partes[3];
    } else if (partes.length === 3) {
        tarjeta = partes[0];
        const mesAnio = partes[1];
        cvv = partes[2];
        if (mesAnio.length === 4) {
            mes = mesAnio.slice(0, 2);
            anio = mesAnio.slice(2);
        } else if (mesAnio.length === 6) {
            mes = mesAnio.slice(0, 2);
            anio = mesAnio.slice(2);
        }
    }

    if (mes && mes.length === 1) mes = '0' + mes;

    let anio2D = '';
    let anio4D = '';
    if (anio) {
        if (/^\d{2}$/.test(anio)) {
            anio2D = anio;
            anio4D = '20' + anio;
        } else if (/^\d{4}$/.test(anio)) {
            anio4D = anio;
            anio2D = anio.slice(-2);
        }
    }

    const tarjetaValida = /^\d{15,16}$/.test(tarjeta);
    const mesValido = /^(0[1-9]|1[0-2])$/.test(mes);
    const numAnio = parseInt(anio4D, 10);
    const anioValido = !isNaN(numAnio) && numAnio >= 2026 && numAnio <= 2099;
    const cvvValido = /^\d{3,4}$/.test(cvv);

    if (tarjetaValida && mesValido && anioValido && cvvValido) {
        return {
            valido: true,
            tarjeta,
            cc: tarjeta,
            mes,
            anio: anio2D,
            anioCompleto: anio4D,
            cvv,
            ult4: tarjeta.slice(-4)
        };
    }

    return { valido: false };
}

async function cerrarSesionNavegador(id) {
    if (navegadoresActivos.has(id)) {
        const nav = navegadoresActivos.get(id);
        navegadoresActivos.delete(id);
        try {
            const contextos = nav.contexts ? nav.contexts() : [];
            const tareasCierre = [];
            for (const ctx of contextos) {
                const pags = ctx.pages ? ctx.pages() : [];
                for (const p of pags) {
                    tareasCierre.push(p.close().catch(() => {}));
                }
                tareasCierre.push(ctx.close().catch(() => {}));
            }
            tareasCierre.push(nav.close().catch(() => {}));
            await Promise.allSettled(tareasCierre);
        } catch(e) {}
    }
    global.gc?.();
}

async function tomarCapturaEnfocada(pag) {
    if (!pag || (typeof pag.isClosed === 'function' && pag.isClosed())) return null;
    
    const selectoresFoco = [
        'dialog[open]',
        '.modal.show',
        '.modal-content',
        '.alert-danger',
        '.alert-warning',
        '.error-container',
        '[class*="voucher" i]',
        '[class*="receipt" i]',
        '[class*="success" i]',
        '[class*="error" i]',
        '[class*="alert" i]',
        '[class*="modal" i]',
        'main'
    ];

    for (const sel of selectoresFoco) {
        try {
            const el = pag.locator(sel).first();
            if (await el.isVisible({ timeout: 200 }).catch(() => false)) {
                const box = await el.boundingBox().catch(() => null);
                if (box && box.width > 50 && box.height > 30 && box.width < 1200 && box.height < 1000) {
                    return await el.screenshot().catch(() => null);
                }
            }
        } catch(e) {}
    }

    return await pag.screenshot({ fullPage: false }).catch(() => null);
}

// ==============================================================================
// 🧠 2.3 CLASIFICADOR INTELIGENTE DE RESULTADOS (TELCEL Y BAIT)
// ==============================================================================
function extraerFragmentoClave(texto) {
    if (!texto) return "Sin texto de alerta capturado";

    const lineas = texto.split('\n')
        .map(l => l.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        // Ignorar encabezados, navegación y textos promocionales que no representan el resultado del pago.
        .filter(l => l.length > 5 && !/^(telcel|bait|recargas|paquetes|aviso de privacidad|términos|todos los derechos|ingresa tu|número amigo|mi bait|duración|obtén internet|una vez consumidos|datos de línea|para registrar|ingresa los datos|contacto:|forma de pago:)/i.test(l))
        .filter(l => !/todo es muy fácil comprar,? pagar y consultar|factura y|más datos/i.test(l));

    // Priorizar siempre el texto que realmente describe el estado del cobro.
    const prioritarias = lineas.filter(l =>
        /(estamos procesando tu pago|procesando tu pago|pago en proceso|recarga en proceso|pago exitoso|recarga exitosa|transacci[oó]n exitosa|pago aprobado|folio|comprobante|pago rechazado|transacci[oó]n rechazada|tarjeta rechazada|declinada|fondos insuficientes|saldo insuficiente|error de conexi[oó]n|no se pudo completar|no pudimos procesar|int[ée]ntalo m[aá]s tarde)/i.test(l)
    );

    const elegidas = prioritarias.length ? prioritarias : lineas;
    return elegidas.slice(0, 3).join(' | ').slice(0, 180) || "Sin texto de resultado capturado";
}

function clasificarResultadoBait(textoVisibleLimpio, id) {
    if (!textoVisibleLimpio || typeof textoVisibleLimpio !== 'string') {
        return {
            estado: 'DESCONOCIDO',
            subtipo: 'SIN_TEXTO_VISIBLE',
            titulo: '⚠️ RESULTADO NO DETERMINADO',
            icono: '⚠️',
            explicacion: 'No se obtuvo respuesta visible de la pasarela.'
        };
    }

    const txt = textoVisibleLimpio.toLowerCase();

    // 1️⃣ PRIORIDAD MÁXIMA: RECHAZOS BANCARIOS, FONDOS INSUFICIENTES Y ERROR AL COMPLETAR PAGO / ERROR INTERNO
    const esErrorInternoOPago = /(error\s*al\s*completar\s*(tu|su)?\s*pago)|(se\s*ha\s*producido\s*un\s*error\s*interno)|(error\s*interno)|(int[ée]ntelo\s*de\s*nuevo\s*m[áa]s\s*tarde)|(int[ée]ntalo\s*(de\s*nuevo\s*)?m[áa]s\s*tarde)|(no\s*se\s*pudo\s*completar\s*tu\s*pago)/i.test(txt);

    const esFondos = /(fondos\s*insuficientes)|(saldo\s*insuficiente)|(saldo\s*no\s*disponible)|(sin\s*fondos)|(monto\s*no\s*adecuado)|(monto\s*insuficiente)|(no\s*cuenta\s*con\s*fondos)/i.test(txt);
    
    const esTarjetaRechazada = /(tarjeta\s*(inv[áa]lida|no\s*v[áa]lida|rechazada|no\s*soportada|no\s*aceptada|no\s*permitida|declinada))|(n[úu]mero\s*de\s*tarjeta\s*inv[áa]lido)|(cvv\s*incorrecto)|(fecha\s*de\s*vencimiento\s*inv[áa]lida)|(vencimiento\s*inv[áa]lido)|(emisor\s*no\s*soportado)|(tipo\s*de\s*tarjeta\s*no\s*v[áa]lida)|(entidad\s*rechaz[óo])|(bloqueo\s*por\s*seguridad)|(l[íi]mite\s*diario)|(no\s*autorizada\s*por\s*el\s*banco)|(rechazada\s*por\s*el\s*banco)|(intenta\s*con\s*otra\s*tarjeta)|(intente\s*con\s*otra\s*tarjeta)|(consulte\s*con\s*el\s*emisor)|(transacci[óo]n\s*no\s*autorizada)|(no\s*se\s*pudo\s*procesar\s*su\s*pago)|(no\s*se\s*pudo\s*completar\s*el\s*pago)|(pago\s*no\s*autorizado)|(operaci[óo]n\s*declinada)|(pago\s*declinado)/i.test(txt);

    const esErrorGenericoBanco = /(tu\s*solicitud\s*no\s*pudo\s*ser\s*(completada|procesada))|(no\s*se\s*pudo\s*realizar\s*(el\s*pago|la\s*operaci[óo]n))|(transacci[óo]n\s*rechazada)|(pago\s*rechazado)|(error\s*al\s*procesar\s*el\s*pago)|(pago\s*no\s*aplicado)|(cobro\s*rechazado)|(lo\s*sentimos,?\s*no\s*pudimos\s*procesar)/i.test(txt);

    if (esErrorInternoOPago || esFondos || esTarjetaRechazada || esErrorGenericoBanco) {
        return {
            estado: 'RECHAZO_BANCARIO',
            subtipo: 'FORMA_PAGO_RECHAZADA',
            titulo: '❌ RECARGA NO COMPLETADA: PAGO RECHAZADO O SIN FONDOS',
            icono: '💳',
            explicacion: 'Tu forma de pago rechazó el cargo o no cuenta con fondos suficientes.'
        };
    }

    // 2️⃣ ERRORES DE PASARELA / COMUNICACIÓN
    const esErrorPasarela = /(error\s*en\s*la\s*pasarela)|(error\s*de\s*comunicaci[óo]n)|(pasarela\s*no\s*disponible)|(servicio\s*no\s*disponible)|(tiempo\s*de\s*espera\s*agotado)|(paypal\s*no\s*responde)/i.test(txt);
    if (esErrorPasarela) {
        return {
            estado: 'ERROR_PASARELA',
            subtipo: 'FALLO_COMUNICACION',
            titulo: '⚠️ ERROR DE COMUNICACIÓN CON LA PASARELA',
            icono: '⚠️',
            explicacion: 'Ocurrió una falla temporal de conexión con el procesador de pago.'
        };
    }

    // 3️⃣ EN PROCESO / PENDIENTE (JAMÁS SE CONSIDERA ÉXITO)
    const esProcesando = /(tu\s*recarga\s*est[áa]\s*en\s*proceso)|(recarga\s*en\s*proceso)|(pago\s*en\s*proceso)|(procesando\s*tu\s*(pago|recarga|solicitud))|(espera\s*la\s*confirmaci[óo]n)|(estamos\s*procesando\s*tu\s*solicitud)|(validando\s*transacci[óo]n)|(en\s*validaci[óo]n)|(transacci[óo]n\s*pendiente)|(procesando)|(en\s*proceso)|(validando)|(pendiente)/i.test(txt);

    if (esProcesando) {
        return {
            estado: 'PROCESANDO',
            subtipo: 'EN_PROCESO',
            titulo: '⏳ RECARGA EN PROCESO — PENDIENTE DE CONFIRMACIÓN',
            icono: '⏳',
            explicacion: 'La orden fue enviada y se encuentra en validación. Esperando confirmación final.'
        };
    }

    // 4️⃣ ÉXITO REAL (Requiere confirmación explícita Y comprobante/folio final)
    const tieneFolioOComprobante = /(folio:?\s*#?\s*\w+)|(comprobante\s*de\s*(pago|recarga|compra))|(ticket\s*de\s*(compra|pago|recarga))|(n[úu]mero\s*de\s*autorizaci[óo]n:?\s*\w+)|(c[óo]digo\s*de\s*aprobaci[óo]n)/i.test(txt);
    const esAprobacionExplicita = /(¡?recarga\s*exitosa!?)|(¡?pago\s*(exitoso|aprobado|aplicado)!?)|(transacci[óo]n\s*(exitosa|aprobada))|(tu\s*pago\s*ha\s*sido\s*(aprobado|aplicado|procesado\s*con\s*[ée]xito))|(¡?tu\s*recarga\s*fue\s*exitosa!?)|(¡?recarga\s*aplicada!?)|(¡listo!\s*tu\s*recarga)/i.test(txt);

    // Evitar falsos positivos por textos internos de diagnóstico
    const esTextoDiagnostico = /checkout\s*(confirmado|listo)|paypal_card_checkout|card_form_visible/i.test(txt);

    if (!esTextoDiagnostico && (tieneFolioOComprobante || (esAprobacionExplicita && !/(en\s*proceso|pendiente|procesando|validando|iniciad[oa]|error|rechaz)/i.test(txt)))) {
        return {
            estado: 'EXITO',
            subtipo: 'EXITOSO',
            titulo: '🎉 ✅ RECARGA BAIT EXITOSA — PAGO APROBADO',
            icono: '✅',
            explicacion: 'La recarga fue confirmada y acreditada exitosamente con comprobante/folio final.'
        };
    }

    // 5️⃣ ESTADO NO DETERMINADO (No afirmar éxito)
    return {
        estado: 'DESCONOCIDO',
        subtipo: 'SIN_CONFIRMACION_FINAL',
        titulo: '⚠️ TRANSACCIÓN NO CONFIRMADA',
        icono: '⚠️',
        explicacion: 'No se detectó comprobante explícito de aprobación ni rechazo bancario definitivo.'
    };
}

// ==============================================================================
// 🧠 2.4 CLASIFICADOR INTELIGENTE TELCEL (ORDEN ESTRICTO: RECHAZO -> BLOQUEO -> ERROR_TELCEL -> PROCESANDO -> EXITO -> DESCONOCIDO)
// ==============================================================================
function clasificarResultadoTelcel(textoCompleto, id) {
    if (!textoCompleto || typeof textoCompleto !== 'string') {
        return {
            estado: 'DESCONOCIDO',
            subtipo: 'SIN_TEXTO_VISIBLE',
            titulo: '⚠️ RESULTADO NO DETERMINADO',
            icono: '⚠️',
            explicacion: 'No se obtuvo texto de respuesta de Telcel.'
        };
    }

    const txt = textoCompleto.toLowerCase();

    // 1️⃣ PRIORIDAD MÁXIMA: RECHAZO BANCARIO Y FONDOS INSUFICIENTES EXPLÍCITOS (Gana siempre sobre éxito)
    const esFondos = /(fondos\s*insuficientes)|(saldo\s*insuficiente)|(saldo\s*no\s*disponible)|(sin\s*fondos)|(monto\s*no\s*adecuado)|(monto\s*insuficiente)|(no\s*cuenta\s*con\s*fondos)|(no\s*tiene\s*fondos)/i.test(txt);
    
    const esTarjetaRechazada = /(tarjeta\s*(inv[áa]lida|no\s*v[áa]lida|rechazada|no\s*soportada|no\s*aceptada|no\s*reconocida|no\s*permitida|declinada))|(n[úu]mero\s*de\s*tarjeta\s*inv[áa]lido)|(cvv\s*incorrecto)|(fecha\s*de\s*vencimiento\s*inv[áa]lida)|(vencimiento\s*inv[áa]lido)|(emisor\s*no\s*soportado)|(tipo\s*de\s*tarjeta\s*no\s*v[áa]lida)|(revisa\s*el\s*n[úu]mero\s*de\s*tarjeta)|(bin\s*(inv[áa]lido|no\s*v[áa]lido|no\s*soportado))|(entidad\s*rechaz[óo])|(no\s*autorizada\s*por\s*el\s*banco)|(rechazada\s*por\s*el\s*banco)|(intenta\s*con\s*otra\s*tarjeta)|(intente\s*con\s*otra\s*tarjeta)|(consulte\s*con\s*el\s*emisor)|(transacci[óo]n\s*no\s*autorizada)|(no\s*se\s*pudo\s*procesar\s*su\s*pago)|(pago\s*no\s*autorizado)|(operaci[óo]n\s*declinada)|(pago\s*declinado)|(cobro\s*rechazado)|(transacci[óo]n\s*rechazada)|(pago\s*rechazado)/i.test(txt);

    if (esFondos) {
        return {
            estado: 'RECHAZO_BANCARIO',
            subtipo: 'FONDOS_INSUFICIENTES',
            titulo: '❌ RECARGA NO COMPLETADA: FONDOS INSUFICIENTES',
            icono: '💸',
            explicacion: 'El banco emisor declinó la transacción por falta de fondos o saldo disponible.'
        };
    }

    if (esTarjetaRechazada) {
        return {
            estado: 'RECHAZO_BANCARIO',
            subtipo: 'TARJETA_DECLINADA',
            titulo: '❌ RECARGA NO COMPLETADA: TARJETA DECLINADA',
            icono: '💳',
            explicacion: 'El banco emisor o las validaciones de tarjeta rechazaron el cobro.'
        };
    }

    // 2️⃣ BLOQUEO EXPLÍCITO TELCEL (Texto visible explícito: bloqueo por seguridad, límites)
    const esBloqueoTelcel = /(bloqueo\s*por\s*seguridad)|(l[íi]mite\s*de\s*intentos)|(excediste\s*el\s*l[íi]mite)|(l[íi]mite\s*diario)|(transacci[óo]n\s*bloqueada)|(operaci[óo]n\s*bloqueada)/i.test(txt);
    if (esBloqueoTelcel) {
        return {
            estado: 'BLOQUEO_TELCEL',
            subtipo: 'BLOQUEO_SEGURIDAD',
            titulo: '⛔ TRANSACCIÓN BLOQUEADA POR TELCEL',
            icono: '⛔',
            explicacion: 'La plataforma Telcel bloqueó la operación por límite de intentos o seguridad.'
        };
    }

    // 3️⃣ ERROR GENÉRICO / TEMPORAL DE TELCEL (No es rechazo bancario ni lista negra)
    const esErrorGenericoTelcel = /(tu\s*solicitud\s*no\s*pudo\s*ser\s*(completada|procesada))|(esta\s*operaci[óo]n\s*no\s*pudo\s*ser\s*completada)|(no\s*pudo\s*ser\s*completada)|(por\s*favor,?\s*int[ée]ntalo\s*m[áa]s\s*tarde)|(int[ée]ntalo\s*m[áa]s\s*tarde)|(intente\s*m[áa]s\s*tarde)|(no\s*se\s*pudo\s*realizar\s*(el\s*pago|la\s*operaci[óo]n))|(error\s*al\s*procesar)|(hubo\s*un\s*problema\s*al\s*procesar)|(pago\s*no\s*aplicado)/i.test(txt);

    if (esErrorGenericoTelcel) {
        return {
            estado: 'ERROR_TELCEL',
            subtipo: 'ERROR_TEMPORAL',
            titulo: '⚠️ TELCEL NO PUDO COMPLETAR LA OPERACIÓN',
            icono: '🟡',
            explicacion: 'Telcel no pudo completar la operación. El portal no informó una causa definitiva.'
        };
    }

    // 4️⃣ PROCESANDO / PENDIENTE (JAMÁS SE CONSIDERA ÉXITO)
    const esProcesando = /(tu\s*recarga\s*est[áa]\s*en\s*proceso)|(recarga\s*en\s*proceso)|(procesando\s*tu\s*(pago|recarga|solicitud))|(espera\s*un\s*momento)|(validando\s*transacci[óo]n)|(en\s*validaci[óo]n)|(transacci[óo]n\s*en\s*proceso)/i.test(txt);
    if (esProcesando) {
        return {
            estado: 'PROCESANDO',
            subtipo: 'EN_PROCESO',
            titulo: '⏳ RECARGA EN PROCESO — PENDIENTE DE CONFIRMACIÓN',
            icono: '⏳',
            explicacion: 'La recarga fue enviada y se encuentra en validación por Telcel.'
        };
    }

    // 5️⃣ ÉXITO REAL (Exigir confirmación final explícita de recarga/pago exitoso)
    const tieneFolioOComprobante = /(folio:?\s*#?\s*\d+)|(folio\s*de\s*recarga:?\s*\d+)|(n[úu]mero\s*de\s*autorizaci[óo]n:?\s*\d+)/i.test(txt);
    const esExitoExplicito = /(¡?recarga\s*exitosa!?)|(¡?pago\s*exitoso!?)|(¡?tu\s*recarga\s*fue\s*exitosa!?)|(tu\s*pago\s*ha\s*sido\s*(exitoso|aplicado\s*con\s*[ée]xito))|(¡listo!\s*tu\s*recarga)|(recarga\s*aplicada\s*con\s*[ée]xito)|(transacci[óo]n\s*exitosa)/i.test(txt);

    if (tieneFolioOComprobante || (esExitoExplicito && !/(en\s*proceso|pendiente|error|rechaz)/i.test(txt))) {
        return {
            estado: 'EXITO',
            titulo: '🎉 ✅ PAGO EXITOSO — RECARGA APLICADA',
            subtipo: 'EXITOSO',
            icono: '✅',
            explicacion: 'La recarga fue procesada y confirmada exitosamente por Telcel.'
        };
    }

    // 6️⃣ ESTADO NO DETERMINADO
    return {
        estado: 'DESCONOCIDO',
        subtipo: 'ERROR_TEMPORAL',
        titulo: '⚠️ ERROR TEMPORAL / DESCONOCIDO',
        icono: '⚠️',
        explicacion: 'Respuesta no clasificada del portal Telcel.'
    };
}

// ==============================================================================
// 🌐 3. NAVEGADOR TELCEL Y LOGS DE DIAGNÓSTICO
// ==============================================================================
function logTelcel(id, mensaje) {
    console.log(`[Telcel Usuario ${id}] ${mensaje}`);
}

async function lanzarNavegador(id) {
    await cerrarSesionNavegador(id);

    let navegador, contexto, pagina;
    const geoMexico = { latitude: 19.4326, longitude: -99.1332 };

    const usarBrightData = !USE_LOCAL_CHROMIUM && Boolean(BRIGHTDATA_BROWSER_WS && (BRIGHTDATA_BROWSER_WS.startsWith('wss://') || BRIGHTDATA_BROWSER_WS.startsWith('ws://')));

    if (usarBrightData) {
        navegador = await chromium.connectOverCDP(BRIGHTDATA_BROWSER_WS, { timeout: 45000 });
        contexto = navegador.contexts()[0] || await navegador.newContext({
            locale: 'es-MX',
            timezoneId: 'America/Mexico_City',
            geolocation: geoMexico,
            permissions: ['geolocation'],
            viewport: { width: 1280, height: 800 }
        });
        await contexto.grantPermissions(['geolocation'], { origin: 'https://pay.telcel.com' }).catch(() => {});
        await contexto.setGeolocation(geoMexico).catch(() => {});
        pagina = contexto.pages()[0] || await contexto.newPage();
    } else {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--no-first-run',
            '--lang=es-MX'
        ];

        navegador = await chromium.launch({
            headless: ES_HEADLESS,
            slowMo: 0,
            timeout: 30000,
            args
        });
        contexto = await navegador.newContext({
            locale: 'es-MX',
            timezoneId: 'America/Mexico_City',
            geolocation: geoMexico,
            permissions: ['geolocation'],
            viewport: { width: 1280, height: 800 }
        });
        await contexto.grantPermissions(['geolocation'], { origin: 'https://pay.telcel.com' }).catch(() => {});
        pagina = await contexto.newPage();
    }

    navegadoresActivos.set(id, navegador);

    pagina.setDefaultTimeout(30000);
    pagina.setDefaultNavigationTimeout(45000);

    return { navegador, contexto, pagina };
}

async function aceptarUbicacionSiAparece(pagina) {
    if (!pagina || (typeof pagina.isClosed === 'function' && pagina.isClosed())) return false;
    const selectoresUbicacion = [
        'button:has-text("Permitir mientras visito el sitio")',
        'button:has-text("Permitir ubicación")',
        'button:has-text("Permitir siempre")',
        'button:has-text("Compartir mi ubicación")',
        'button:has-text("Usar mi ubicación")',
        'button:has-text("Permitir")',
        'button:has-text("Aceptar")',
        'button:has-text("Acepto")',
        'button:has-text("Entendido")',
        'button:has-text("Activar ubicación")',
        '[aria-label*="Permitir" i]',
        '[aria-label*="Ubicación" i]'
    ];

    for (const s of selectoresUbicacion) {
        try {
            const btn = pagina.locator(s).first();
            if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
                await btn.click({ force: true }).catch(() => {});
                return true;
            }
        } catch(e) {}
    }
    return false;
}

// ==============================================================================
// 📦 4. FUNCIONES MODULARES DE PAQUETES (TELCEL)
// ==============================================================================
async function encontrarPrimeroVisible(locator, timeout = 10000) {
    const inicio = Date.now();

    while (Date.now() - inicio < timeout) {
        const total = await locator.count().catch(() => 0);

        for (let i = 0; i < total; i++) {
            const candidato = locator.nth(i);
            if (await candidato.isVisible().catch(() => false)) {
                return candidato;
            }
        }

        await new Promise(resolve => setTimeout(resolve, 150));
    }

    return null;
}

async function esperarMontoVisibleTelcel(pagina, monto, timeout = 15000) {
    const textoMonto = pagina.getByText(new RegExp(`^\\$\\s*${monto}$`, 'i'));
    return await encontrarPrimeroVisible(textoMonto, timeout);
}

async function buscarBotonPaquetePorMonto(pagina, monto, timeout = 15000, id = '') {
    const inicio = Date.now();
    const botonesLoQuiero = pagina.getByText('Lo quiero', { exact: true });

    while (Date.now() - inicio < timeout) {
        const total = await botonesLoQuiero.count().catch(() => 0);

        for (let i = 0; i < total; i++) {
            const candidato = botonesLoQuiero.nth(i);

            if (!(await candidato.isVisible().catch(() => false))) {
                continue;
            }

            const perteneceAlMonto = await candidato.evaluate((elemento, montoObjetivo) => {
                const montoTexto = `$${montoObjetivo}`.replace(/\s+/g, '');
                let nodo = elemento;

                // Subir solo lo necesario por el árbol hasta encontrar el contenedor
                // que reúne el precio objetivo y el texto "Lo quiero".
                for (let nivel = 0; nivel < 10 && nodo; nivel++, nodo = nodo.parentElement) {
                    const texto = (nodo.innerText || nodo.textContent || '')
                        .replace(/\u00a0/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();

                    const textoSinEspacios = texto.replace(/\s+/g, '');
                    if (textoSinEspacios.includes(montoTexto) && /Lo quiero/i.test(texto)) {
                        return true;
                    }
                }

                return false;
            }, String(monto)).catch(() => false);

            if (perteneceAlMonto) {
                logTelcel(id, `✅ Botón 'Lo quiero' asociado a $${monto} localizado.`);
                return candidato;
            }
        }

        await new Promise(resolve => setTimeout(resolve, 150));
    }

    return null;
}

async function abrirMasPaquetes(pagina, monto, id = '') {
    const tInicio = Date.now();
    logTelcel(id, `📦 Buscando paquete $${monto}...`);

    // PASO 1: si el monto ya está visible, no gastar tiempo buscando "Ver más paquetes".
    let montoVisible = await esperarMontoVisibleTelcel(pagina, monto, 2500);
    if (montoVisible) {
        logTelcel(id, `✅ Paquete $${monto} ya está visible; no hace falta expandir (${Date.now() - tInicio} ms).`);
        return true;
    }

    // PASO 2: buscar el texto real confirmado visualmente en Telcel Pay.
    logTelcel(id, `🔎 Buscando texto 'Ver más paquetes'...`);
    const candidatosVerMas = pagina.getByText('Ver más paquetes', { exact: true });
    const botonVerMas = await encontrarPrimeroVisible(candidatosVerMas, 12000);

    if (!botonVerMas) {
        logTelcel(id, `⚠️ 'Ver más paquetes' no apareció como elemento visible.`);

        // Una última comprobación directa por si el catálogo terminó de renderizar tarde.
        montoVisible = await esperarMontoVisibleTelcel(pagina, monto, 5000);
        if (montoVisible) {
            logTelcel(id, `✅ Paquete $${monto} apareció directamente sin expandir.`);
            return true;
        }

        await pagina.screenshot({
            path: `telcel-paquete-${monto}-ver-mas-no-visible-${id || 'sin-id'}.png`,
            fullPage: false
        }).catch(() => {});

        throw new Error(`VER_MAS_PAQUETES_NO_VISIBLE_$${monto}`);
    }

    logTelcel(id, `✅ 'Ver más paquetes' visible en ${Date.now() - tInicio} ms.`);

    // PASO 3: hacer clic únicamente después de confirmar visibilidad.
    await botonVerMas.scrollIntoViewIfNeeded().catch(() => {});

    const tClick = Date.now();
    try {
        await botonVerMas.click({ timeout: 5000 });
    } catch (errorClickNormal) {
        logTelcel(id, `⚠️ Clic normal no respondió; reintentando clic directo sobre el mismo elemento.`);
        await botonVerMas.click({ force: true, timeout: 5000 });
    }

    logTelcel(id, `🖱️ Clic en 'Ver más paquetes' realizado en ${Date.now() - tClick} ms.`);

    // PASO 4: en vez de esperar networkidle, esperar exactamente el monto solicitado.
    montoVisible = await esperarMontoVisibleTelcel(pagina, monto, 20000);

    if (!montoVisible) {
        await pagina.screenshot({
            path: `telcel-paquete-${monto}-despues-ver-mas-${id || 'sin-id'}.png`,
            fullPage: false
        }).catch(() => {});

        throw new Error(`PAQUETE_$${monto}_NO_VISIBLE`);
    }

    logTelcel(id, `✅ Paquete $${monto} visible después de expandir en ${Date.now() - tInicio} ms.`);
    return true;
}

async function seleccionarPaquete(pagina, monto, id = '') {
    const tInicio = Date.now();
    logTelcel(id, `🔍 Localizando botón correcto para paquete $${monto}...`);

    // Confirmar primero que el monto realmente está visible.
    const montoVisible = await esperarMontoVisibleTelcel(pagina, monto, 10000);
    if (!montoVisible) {
        await pagina.screenshot({
            path: `telcel-paquete-${monto}-no-visible-seleccion-${id || 'sin-id'}.png`,
            fullPage: false
        }).catch(() => {});
        throw new Error(`PAQUETE_$${monto}_NO_VISIBLE`);
    }

    // No depender de clases CSS generadas por Telcel.
    // Se revisan los elementos visibles "Lo quiero" y se elige únicamente el que
    // pertenece a un contenedor cuyo texto también contiene el monto solicitado.
    const botonLoQuiero = await buscarBotonPaquetePorMonto(pagina, monto, 15000, id);

    if (!botonLoQuiero) {
        await pagina.screenshot({
            path: `telcel-paquete-${monto}-boton-no-encontrado-${id || 'sin-id'}.png`,
            fullPage: false
        }).catch(() => {});
        throw new Error(`BOTON_LO_QUIERO_$${monto}_NO_VISIBLE`);
    }

    await botonLoQuiero.scrollIntoViewIfNeeded().catch(() => {});

    if (!(await botonLoQuiero.isEnabled().catch(() => true))) {
        throw new Error(`BOTON_LO_QUIERO_$${monto}_NO_HABILITADO`);
    }

    logTelcel(id, `🖱️ Seleccionando paquete $${monto}...`);
    const tClick = Date.now();

    try {
        await botonLoQuiero.click({ timeout: 5000 });
    } catch (errorClickNormal) {
        logTelcel(id, `⚠️ Clic normal en 'Lo quiero' no respondió; reintentando sobre el mismo botón.`);
        await botonLoQuiero.click({ force: true, timeout: 5000 });
    }

    // Señal concreta de avance: el campo de número debe aparecer.
    const campoNumero = pagina.locator('input#id-phone-p').first();
    await campoNumero.waitFor({ state: 'attached', timeout: 20000 });
    await campoNumero.waitFor({ state: 'visible', timeout: 20000 });

    logTelcel(id, `✅ Paquete $${monto} seleccionado; campo de número visible en ${Date.now() - tClick} ms (total ${Date.now() - tInicio} ms).`);
    return true;
}

async function detectarNumeroInvalido(page) {
    if (!page || page.isClosed()) return { esInvalido: false };

    // Patrones regex para reconocer mensajes de número inválido / incorrecto
    const regexInvalido = new RegExp(
        [
            'n[uú]mero\\s+(?:inv[aá]lido|no\\s+v[aá]lido|incorrecto|no\\s+encontrado|no\\s+registrado|no\\s+pertenece|no\\s+existe|inv[aá]lida)',
            'verifica\\s+(?:tu|el)\\s+n[uú]mero',
            'ingresa\\s+un\\s+n[uú]mero\\s+v[aá]lido',
            'n[uú]mero\\s+telcel\\s+no\\s+v[aá]lido',
            '(?:la\\s+)?l[ií]nea\\s+(?:no\\s+es\\s+v[aá]lida|no\\s+v[aá]lida|no\\s+encontrada|inv[aá]lida|no\\s+pertenece|no\\s+compatible|no\\s+registrada)',
            'n[uú]mero\\s+no\\s+pertenece\\s+a\\s+(?:la\\s+red\\s+)?bait',
            'l[ií]nea\\s+no\\s+registrada',
            'el\\s+n[uú]mero\\s+no\\s+es\\s+v[aá]lido',
            'n[uú]mero\\s+telef[oó]nico\\s+inv[aá]lido'
        ].join('|'),
        'i'
    );

    // Errores genéricos que NO deben ser clasificados como número inválido
    const regexGenerico = /ocurri[oó]\s+un\s+error|int[eé]ntalo\s+(?:m[aá]s\s+tarde|de\s+nuevo)|servicio\s+no\s+disponible|error\s+de\s+conexi[oó]n|no\s+pudimos\s+conectar/i;

    try {
        const frames = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())];

        for (const frame of frames) {
            // 1. Revisar textos visibles en elementos de alerta/error comunes
            const selectoresAlerta = [
                '.error-message',
                '.form-error',
                '.invalid-feedback',
                '.text-danger',
                '.alert-danger',
                '[role="alert"]',
                '.mat-error',
                '.Mui-error',
                '.error',
                'small.error',
                'span.error',
                'div.error',
                'p.error'
            ];

            for (const sel of selectoresAlerta) {
                const elementos = frame.locator(sel);
                const count = await elementos.count().catch(() => 0);
                for (let i = 0; i < count; i++) {
                    const txt = await elementos.nth(i).innerText().catch(() => '');
                    if (txt && regexInvalido.test(txt) && !regexGenerico.test(txt)) {
                        return { esInvalido: true, mensaje: txt.trim() };
                    }
                }
            }

            // 2. Revisar todo el texto del body del frame
            const textoBody = await frame.locator('body').innerText({ timeout: 500 }).catch(() => '');
            if (textoBody && regexInvalido.test(textoBody) && !regexGenerico.test(textoBody)) {
                const matchInvalido = textoBody.match(regexInvalido);
                if (matchInvalido) {
                    return { esInvalido: true, mensaje: matchInvalido[0].trim() };
                }
            }
        }
    } catch (_) {}

    return { esInvalido: false };
}

async function ejecutarConReintento(fn, intentosMax = 3, id) {
    let ultimoError = null;
    for (let intento = 1; intento <= intentosMax; intento++) {
        try {
            return await fn(intento);
        } catch (error) {
            ultimoError = error;
            if (error && error.message === 'NUMERO_INVALIDO') {
                throw error;
            }
            if (intento < intentosMax) {
                await cerrarSesionNavegador(id);
            }
        }
    }
    throw ultimoError;
}

// ==============================================================================
// 💳 5. FLUJO AUTOMÁTICO DE RECARGA TELCEL ($200, $300, $500)
// ==============================================================================
async function flujoTelcelIndependiente(ctx, id, datos) {
    const { numero, cc, mes, anio, anioCompleto, cvv, nombre, monto: montoIn } = datos;
    const monto = montoIn || 200;

    logTelcel(id, `🚀 Iniciando flujo Telcel (Monto: $${monto}, Línea: ${numero.slice(0, 3)}***${numero.slice(-3)})`);

    await enviarLimpio(ctx,
        `🦁 <b>BOT LEÓN — PROCESANDO TELCEL</b> 🤖\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 <b>Línea:</b> <code>${numero}</code>\n` +
        `💲 <b>Monto:</b> $${monto} MXN\n\n` +
        `⏳ ▫️ Conectando con Telcel Pay...\n` +
        `▫️ No cierres esta ventana.`
    );

    let ultimaCapturaError = null;
    let ultimaEtapa = "Inicialización";

    try {
        await ejecutarConReintento(async (intento) => {
            const miId = (ejecucionesUsuario.get(id) || 0) + 1;
            ejecucionesUsuario.set(id, miId);

            logTelcel(id, `🔄 Intento Telcel ${intento}/3`);

            let sesion = null;
            let pagina = null;

            try {
                ultimaEtapa = "Apertura de navegador";
                logTelcel(id, `🌐 Abriendo navegador`);
                let t = Date.now();
                sesion = await lanzarNavegador(id);
                pagina = sesion.pagina;
                logTelcel(id, `✅ Navegador abierto en ${Date.now() - t} ms`);

                pagina.on('dialog', async dialog => {
                    await dialog.accept().catch(() => {});
                });

                pagina.on('popup', async popup => {
                    await aceptarUbicacionSiAparece(popup);
                    await popup.close().catch(() => {});
                });

                ultimaEtapa = "Navegación a Telcel Pay";
                logTelcel(id, `🌐 Navegando a Telcel Pay (${URL_TELCEL})`);
                t = Date.now();
                await pagina.goto(URL_TELCEL, { waitUntil: 'commit', timeout: 45000 });
                await pagina.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
                await pagina.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
                logTelcel(id, `✅ Página Telcel cargada en ${Date.now() - t} ms`);

                t = Date.now();
                const ubicacionAceptada = await aceptarUbicacionSiAparece(pagina);
                logTelcel(id, `📍 Permiso de ubicación configurado/verificado (${Date.now() - t} ms, aceptado: ${ubicacionAceptada})`);

                ultimaEtapa = "Apertura de paquetes adicionales";
                await abrirMasPaquetes(pagina, monto, id);

                ultimaEtapa = `Selección de paquete $${monto}`;
                await seleccionarPaquete(pagina, monto, id);

                ultimaEtapa = "Ingreso de número celular";
                logTelcel(id, `📱 Buscando campo de número`);
                t = Date.now();
                const inputNumeroSel = 'input#id-phone-p';
                const campoTel = pagina.locator(inputNumeroSel).first();
                await campoTel.waitFor({ state: 'attached', timeout: 25000 });
                await campoTel.waitFor({ state: 'visible', timeout: 25000 });

                if (!(await campoTel.isEditable().catch(() => false)) || !(await campoTel.isEnabled().catch(() => false))) {
                    throw new Error("CAMPO_NUMERO_NO_DISPONIBLE");
                }

                await campoTel.scrollIntoViewIfNeeded().catch(() => {});
                await campoTel.click({ force: true });
                await campoTel.fill(numero, { force: true });
                await campoTel.dispatchEvent('input', { bubbles: true }).catch(() => {});
                await campoTel.dispatchEvent('change', { bubbles: true }).catch(() => {});
                await campoTel.dispatchEvent('blur', { bubbles: true }).catch(() => {});

                await pagina.waitForFunction(({ sel, num }) => {
                    const el = document.querySelector(sel);
                    return el && el.value === num;
                }, { sel: inputNumeroSel, num: numero }, { timeout: 10000 }).catch(() => {});

                logTelcel(id, `✅ Número ingresado en ${Date.now() - t} ms`);

                logTelcel(id, `➡️ Continuando a forma de pago`);
                t = Date.now();
                const btnContinuarTel = pagina.locator('button.fontBoldAMX:has-text("Continuar"), button.bg-\\[\\#7b1fa2\\]:has-text("Continuar"), button:has-text("Continuar"), button[type="submit"]').first();
                await btnContinuarTel.waitFor({ state: 'visible', timeout: 25000 });
                await btnContinuarTel.scrollIntoViewIfNeeded().catch(() => {});
                await btnContinuarTel.click({ force: true });
                await pagina.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
                logTelcel(id, `✅ Clic en continuar realizado en ${Date.now() - t} ms`);

                await pagina.waitForTimeout(800);
                const verifNumTel = await detectarNumeroInvalido(pagina);
                if (verifNumTel && verifNumTel.esInvalido) {
                    const err = new Error('NUMERO_INVALIDO');
                    err.esNumeroInvalido = true;
                    err.mensajeInvalido = verifNumTel.mensaje;
                    throw err;
                }

                ultimaEtapa = "Llenado de datos de tarjeta";
                logTelcel(id, `⏳ Esperando formulario siguiente (tarjeta)`);
                t = Date.now();
                const inputCC = pagina.locator('input#creditCardNumber, input[placeholder*="16 dígitos" i], input[name="cardNumber"]').first();
                await inputCC.waitFor({ state: 'attached', timeout: 30000 });
                await inputCC.waitFor({ state: 'visible', timeout: 30000 });
                logTelcel(id, `✅ Formulario siguiente detectado en ${Date.now() - t} ms`);

                if (!(await inputCC.isEditable().catch(() => false)) || !(await inputCC.isEnabled().catch(() => false))) {
                    throw new Error("CAMPO_TARJETA_NO_DISPONIBLE");
                }

                t = Date.now();
                await inputCC.scrollIntoViewIfNeeded().catch(() => {});
                await inputCC.click({ force: true });
                await inputCC.fill(cc, { force: true });
                await inputCC.dispatchEvent('input', { bubbles: true }).catch(() => {});
                await inputCC.dispatchEvent('change', { bubbles: true }).catch(() => {});
                await inputCC.dispatchEvent('blur', { bubbles: true }).catch(() => {});

                const inputNom = pagina.locator('input#creditCardName, input[placeholder*="Nombre completo" i], input[name="cardHolderName"]').first();
                await inputNom.waitFor({ state: 'visible', timeout: 20000 });
                await inputNom.scrollIntoViewIfNeeded().catch(() => {});
                await inputNom.click({ force: true });
                await inputNom.fill(typeof nombre === 'object' ? nombre.completo : nombre, { force: true });
                await inputNom.dispatchEvent('input', { bubbles: true }).catch(() => {});
                await inputNom.dispatchEvent('change', { bubbles: true }).catch(() => {});
                await inputNom.dispatchEvent('blur', { bubbles: true }).catch(() => {});

                const inputMes = pagina.locator('input#month, input.exp[placeholder="MM"], input[placeholder="MM"]').first();
                const inputAnio = pagina.locator('input#year, input.exp[placeholder="AA"], input[placeholder="AA"], input[placeholder="AAAA"]').first();
                const inputFecha = pagina.locator('input[name="cardExpiry"][placeholder="MM / AA"], input[placeholder*="MM / AA" i]').first();

                if (await inputMes.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await inputMes.scrollIntoViewIfNeeded().catch(() => {});
                    await inputMes.click({ force: true });
                    await inputMes.fill(mes, { force: true });
                    await inputMes.dispatchEvent('input', { bubbles: true }).catch(() => {});
                    await inputMes.dispatchEvent('change', { bubbles: true }).catch(() => {});

                    if (await inputAnio.isVisible({ timeout: 2000 }).catch(() => false)) {
                        await inputAnio.scrollIntoViewIfNeeded().catch(() => {});
                        await inputAnio.click({ force: true });
                        const phAnio = await inputAnio.getAttribute('placeholder').catch(() => '') || '';
                        const valorAnio = phAnio.toLowerCase().includes('aaaa') ? (anioCompleto || `20${anio}`) : anio;
                        await inputAnio.fill(valorAnio, { force: true });
                        await inputAnio.dispatchEvent('input', { bubbles: true }).catch(() => {});
                        await inputAnio.dispatchEvent('change', { bubbles: true }).catch(() => {});
                    }
                } else if (await inputFecha.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await inputFecha.scrollIntoViewIfNeeded().catch(() => {});
                    await inputFecha.click({ force: true });
                    await inputFecha.fill(`${mes}/${anio}`, { force: true });
                    await inputFecha.dispatchEvent('input', { bubbles: true }).catch(() => {});
                    await inputFecha.dispatchEvent('change', { bubbles: true }).catch(() => {});
                    await inputFecha.dispatchEvent('blur', { bubbles: true }).catch(() => {});
                }

                const inputCvv = pagina.locator('input#cvv-input, input[placeholder="000"], input[name="cardCvv"], input[placeholder*="CVV" i]').first();
                if (await inputCvv.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await inputCvv.scrollIntoViewIfNeeded().catch(() => {});
                    await inputCvv.click({ force: true });
                    await inputCvv.fill(cvv, { force: true });
                    await inputCvv.dispatchEvent('input', { bubbles: true }).catch(() => {});
                    await inputCvv.dispatchEvent('change', { bubbles: true }).catch(() => {});
                    await inputCvv.dispatchEvent('blur', { bubbles: true }).catch(() => {});
                }

                const checkboxTerms = pagina.locator('input[type="checkbox"]#terms, input[type="checkbox"][name*="terms" i]').first();
                if (await checkboxTerms.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await checkboxTerms.scrollIntoViewIfNeeded().catch(() => {});
                    await checkboxTerms.check({ force: true }).catch(() => checkboxTerms.click({ force: true }));
                }

                await pagina.evaluate(() => {
                    document.querySelectorAll('input').forEach(input => {
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        input.dispatchEvent(new Event('blur', { bubbles: true }));
                    });
                }).catch(() => {});
                logTelcel(id, `✅ Datos de tarjeta llenados en ${Date.now() - t} ms`);

                // 2. CONFIRMACIÓN DE PAGO (SIN MUTACIÓN FORZADA DEL DOM — ESPERA NATURAL DE ENABLED)
                ultimaEtapa = "Confirmación de pago";
                const btnContinuar = pagina.locator('button[type="submit"].bg-\\[\\#7b1fa2\\]:has-text("Continuar"), button[type="submit"]:has-text("Continuar"), button:has-text("Continuar"), button:has-text("Pagar")').last();
                await btnContinuar.waitFor({ state: 'attached', timeout: 25000 });
                await btnContinuar.waitFor({ state: 'visible', timeout: 25000 });
                await btnContinuar.scrollIntoViewIfNeeded().catch(() => {});

                const inicioEsperaBtn = Date.now();
                while (Date.now() - inicioEsperaBtn < 10000) {
                    if (await btnContinuar.isEnabled().catch(() => false)) {
                        break;
                    }
                    await pagina.waitForTimeout(200);
                }

                logTelcel(id, `💸 Clic en botón confirmar/pagar`);
                if (await btnContinuar.isEnabled().catch(() => false)) {
                    await btnContinuar.click();
                } else {
                    await btnContinuar.click({ force: true }).catch(() => {});
                }

                const btnFisica = pagina.locator('button.ModalInvitation_buttonModal__42s7X, button:has-text("Continuar con mi tarjeta física"), button:has-text("tarjeta física")').first();
                if (await btnFisica.isVisible({ timeout: 4000 }).catch(() => false)) {
                    await btnFisica.scrollIntoViewIfNeeded().catch(() => {});
                    await btnFisica.click({ force: true }).catch(() => {});
                }

                // 4. ESPERA ACTIVA ROBUSTA (MÁXIMO 65s; exige estado final estable antes de capturar)
                ultimaEtapa = "Analizando respuesta y comprobante";
                logTelcel(id, `⏳ Esperando confirmación/respuesta del portal (máx 65s)...`);
                const inicioEspera = Date.now();
                const TIEMPO_MAXIMO_ESPERA_TELCEL_MS = 65000;
                let textoFinalPagina = "";
                let clasificacionFinal = null;
                let ultimoEstadoLog = null;
                let estadoFinalCandidato = null;
                let repeticionesEstadoFinal = 0;

                while (Date.now() - inicioEspera < TIEMPO_MAXIMO_ESPERA_TELCEL_MS) {
                    // Leer el resultado desde la página principal, popups y TODOS los frames/iframes.
                    // Pay Telcel puede mostrar "Estamos procesando tu pago" dentro de un frame distinto
                    // al documento principal; si sólo leemos `pagina.evaluate()` ese texto se puede perder.
                    const paginasContexto = pagina.context()?.pages?.() || [pagina];
                    const fragmentosTotales = [];

                    for (const pActual of paginasContexto) {
                        if (!pActual || pActual.isClosed()) continue;
                        const framesActuales = pActual.frames ? pActual.frames() : [pActual];

                        for (const frameActual of framesActuales) {
                            try {
                                const textoFrame = await frameActual.evaluate(() => {
                                    const selectores = [
                                        'dialog[open]',
                                        'dialog',
                                        '.alert',
                                        '.error',
                                        '.modal-content',
                                        '[class*="alert" i]',
                                        '[class*="error" i]',
                                        '[class*="modal" i]',
                                        '[class*="voucher" i]',
                                        '[class*="receipt" i]',
                                        '[class*="success" i]',
                                        '[class*="result" i]',
                                        '[class*="summary" i]',
                                        'main',
                                        'body'
                                    ];

                                    const esVisible = el => {
                                        if (!el) return false;
                                        const s = window.getComputedStyle(el);
                                        return s && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
                                    };

                                    const fragmentos = [];
                                    for (const sel of selectores) {
                                        document.querySelectorAll(sel).forEach(el => {
                                            if (!esVisible(el)) return;
                                            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
                                            if (t.length > 0 && !fragmentos.includes(t)) fragmentos.push(t);
                                        });
                                    }
                                    return fragmentos.join(' \n ');
                                }).catch(() => '');

                                if (textoFrame && textoFrame.trim()) fragmentosTotales.push(textoFrame.trim());
                            } catch (_) {}
                        }
                    }

                    textoFinalPagina = [...new Set(fragmentosTotales)].join(' \n ');

                    clasificacionFinal = clasificarResultadoTelcel(textoFinalPagina, id);

                    if (clasificacionFinal.estado === 'PROCESANDO') {
                        if (ultimoEstadoLog !== 'PROCESANDO') {
                            ultimoEstadoLog = 'PROCESANDO';
                            logTelcel(id, `⏳ Telcel sigue procesando el pago... (${Date.now() - inicioEspera} ms)`);
                        }
                    } else if (clasificacionFinal.estado !== ultimoEstadoLog && clasificacionFinal.estado !== 'DESCONOCIDO') {
                        ultimoEstadoLog = clasificacionFinal.estado;
                        logTelcel(id, `🔎 Estado detectado: ${clasificacionFinal.estado} en ${Date.now() - inicioEspera} ms`);
                    }

                    // Un estado final debe mantenerse en varias lecturas antes de cerrar el polling.
                    // Esto evita capturas tomadas durante una transición o mientras el icono final aún no termina de renderizar.
                    if (['EXITO', 'RECHAZO_BANCARIO', 'BLOQUEO_TELCEL', 'ERROR_TELCEL'].includes(clasificacionFinal.estado)) {
                        if (estadoFinalCandidato === clasificacionFinal.estado) {
                            repeticionesEstadoFinal += 1;
                        } else {
                            estadoFinalCandidato = clasificacionFinal.estado;
                            repeticionesEstadoFinal = 1;
                        }

                        if (repeticionesEstadoFinal >= 3) {
                            logTelcel(id, `✅ Estado final estable: ${clasificacionFinal.estado}. Esperando render visual final...`);
                            await pagina.waitForTimeout(1500);
                            break;
                        }
                    } else {
                        estadoFinalCandidato = null;
                        repeticionesEstadoFinal = 0;
                    }

                    await pagina.waitForTimeout(700);
                }

                if (!clasificacionFinal || clasificacionFinal.estado === 'DESCONOCIDO') {
                    clasificacionFinal = clasificarResultadoTelcel(textoFinalPagina, id);
                }

                // Si tras el tiempo máximo se observó PROCESANDO, conservarlo intacto como PROCESANDO/PENDIENTE
                if (ultimoEstadoLog === 'PROCESANDO' && clasificacionFinal.estado === 'DESCONOCIDO') {
                    clasificacionFinal = {
                        estado: 'PROCESANDO',
                        subtipo: 'EN_PROCESO',
                        titulo: '⏳ RECARGA EN PROCESO — PENDIENTE DE CONFIRMACIÓN',
                        icono: '⏳',
                        explicacion: 'La recarga fue enviada y se encuentra en validación por Telcel.'
                    };
                }

                logTelcel(id, `🔎 Estado final Telcel: ${clasificacionFinal.estado} (Tiempo total de espera: ${Date.now() - inicioEspera} ms)`);

                if (miId === ejecucionesUsuario.get(id)) {
                    const fragmentoLeido = extraerFragmentoClave(textoFinalPagina);
                    // Capturar sólo estados verdaderamente finales. Si Telcel sigue en "procesando"
                    // o no hay confirmación, NO enviar una imagen intermedia como si fuera resultado.
                    const estadoConCaptura = ['EXITO', 'RECHAZO_BANCARIO', 'BLOQUEO_TELCEL', 'ERROR_TELCEL'].includes(clasificacionFinal.estado);
                    const capturaVoucher = estadoConCaptura
                        ? await tomarCapturaEnfocada(pagina).catch(() => null)
                        : null;

                    await limpiarMensajesTemporales(ctx, id);

                    let mensajeTelegram = '';

                    if (clasificacionFinal.estado === 'EXITO') {
                        mensajeTelegram = 
                            `🦁 <b>BOT LEÓN — COMPROBANTE DE RECARGA EXITOSA</b> ✅\n` +
                            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                            `📱 <b>Línea:</b> <code>${numero}</code>\n` +
                            `💲 <b>Monto:</b> $${monto} MXN\n` +
                            `✅ <b>Estado:</b> Pago aprobado y recarga aplicada\n` +
                            `📄 <b>Detalle:</b> "<i>${fragmentoLeido}</i>"\n` +
                            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                            `👉 <b>Toca /start para realizar otra recarga.</b>`;

                        if (capturaVoucher) {
                            await ctx.replyWithPhoto({ source: capturaVoucher }, {
                                caption: mensajeTelegram.slice(0, 1024),
                                parse_mode: 'HTML'
                            });
                        } else {
                            await ctx.replyWithHTML(mensajeTelegram);
                        }

                    } else if (clasificacionFinal.estado === 'RECHAZO_BANCARIO') {
                        const sPrev = sesiones.get(id) || {};
                        const intentos = (sPrev.intentosTarjeta || 0) + 1;
                        sPrev.intentosTarjeta = intentos;
                        sesiones.set(id, sPrev);

                        if (intentos >= 2) {
                            sesiones.delete(id);
                            mensajeTelegram = 
                                `❌ <b>RECARGA NO COMPLETADA: MONTO / FONDOS INSUFICIENTES</b>\n` +
                                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                                `📱 <b>Línea:</b> <code>${numero}</code>\n` +
                                `💲 <b>Monto:</b> $${monto} MXN\n\n` +
                                `💡 <b>Motivo:</b> La segunda tarjeta no cuenta con fondos suficientes o fue rechazada por el banco.\n` +
                                `🔄 <b>Reiniciando proceso...</b> Toca /start para comenzar de nuevo:`;

                            if (capturaVoucher) {
                                await ctx.replyWithPhoto({ source: capturaVoucher }, {
                                    caption: mensajeTelegram.slice(0, 1024),
                                    parse_mode: 'HTML'
                                });
                            } else {
                                await ctx.replyWithHTML(mensajeTelegram);
                            }
                        } else {
                            mensajeTelegram = 
                                `❌ <b>RECARGA NO COMPLETADA: MONTO / FONDOS INSUFICIENTES</b>\n` +
                                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                                `📱 <b>Línea:</b> <code>${numero}</code>\n` +
                                `💲 <b>Monto:</b> $${monto} MXN\n\n` +
                                `💡 <b>Motivo:</b> La tarjeta no cuenta con el monto adecuado para realizar la recarga.\n\n` +
                                `👉 <b>Escribe tu nueva tarjeta para reintentar:</b>\n` +
                                `<code>16DÍGITOS|MM|AA|CVV</code>`;

                            if (capturaVoucher) {
                                await ctx.replyWithPhoto({ source: capturaVoucher }, {
                                    caption: mensajeTelegram.slice(0, 1024),
                                    parse_mode: 'HTML'
                                });
                            } else {
                                await ctx.replyWithHTML(mensajeTelegram);
                            }
                        }
                    } else if (clasificacionFinal.estado === 'PROCESANDO') {
                        mensajeTelegram = 
                            `⏳ <b>RECARGA EN PROCESO — PENDIENTE DE CONFIRMACIÓN</b>\n` +
                            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                            `📱 <b>Línea:</b> <code>${numero}</code>\n` +
                            `💲 <b>Monto:</b> $${monto} MXN\n` +
                            `📄 <b>Mensaje de Telcel:</b> "<i>${fragmentoLeido}</i>"\n\n` +
                            `ℹ️ <b>Telcel continúa procesando el pago.</b> Aún no existe confirmación final de éxito o rechazo.\n` +
                            `🔎 <b>Verifica el estado de la recarga antes de volver a intentar.</b>`;

                        if (capturaVoucher) {
                            await ctx.replyWithPhoto({ source: capturaVoucher }, {
                                caption: mensajeTelegram.slice(0, 1024),
                                parse_mode: 'HTML'
                            });
                        } else {
                            await ctx.replyWithHTML(mensajeTelegram);
                        }
                    } else {
                        mensajeTelegram = 
                            `⚠️ <b>${clasificacionFinal.titulo}</b>\n` +
                            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                            `📱 <b>Línea:</b> <code>${numero}</code>\n` +
                            `💲 <b>Monto:</b> $${monto} MXN\n\n` +
                            `📄 <b>Mensaje detectado:</b> "<i>${fragmentoLeido}</i>"\n\n` +
                            `ℹ️ <b>No se obtuvo una confirmación final confiable.</b>\n` +
                            `🔎 Verifica el estado de la recarga antes de volver a intentar.`;

                        if (capturaVoucher) {
                            await ctx.replyWithPhoto({ source: capturaVoucher }, {
                                caption: mensajeTelegram.slice(0, 1024),
                                parse_mode: 'HTML'
                            });
                        } else {
                            await ctx.replyWithHTML(mensajeTelegram);
                        }
                    }
                }

                return true;

            } catch (errIntento) {
                ultimaEtapa = errIntento.message || ultimaEtapa;
                logTelcel(id, `❌ Etapa donde falló: ${ultimaEtapa}`);
                logTelcel(id, `❌ Error: ${errIntento.message || errIntento}`);
                logTelcel(id, `🌐 URL actual: ${pagina && !pagina.isClosed() ? pagina.url() : 'N/A'}`);
                if (pagina && !pagina.isClosed()) {
                    ultimaCapturaError = await tomarCapturaEnfocada(pagina);
                }
                throw errIntento;
            } finally {
                logTelcel(id, `🧹 Cerrando sesión de navegador Telcel`);
                await cerrarSesionNavegador(id);
            }
        }, 3, id);

    } catch (errTelcel) {
        logTelcel(id, `❌ Fallo total Telcel: ${errTelcel.message || errTelcel}`);
        await limpiarMensajesTemporales(ctx, id);

        if (errTelcel && errTelcel.message === 'NUMERO_INVALIDO') {
            console.log(`[Telcel Usuario ${id}] ⚠️ NUMERO_INVALIDO detectado`);
            console.log(`[Telcel Usuario ${id}] 🧹 Intento anterior cerrado`);
            console.log(`[Telcel Usuario ${id}] 🔄 Esperando nuevo número`);

            const s = sesiones.get(id) || datos;
            s.paso = 'numero';
            s.numero = null;
            sesiones.set(id, s);

            await ctx.replyWithHTML(
                `❌ <b>El número ingresado no es válido o no fue reconocido.</b>\n\n` +
                `📱 <b>Ingresa nuevamente el número de 10 dígitos:</b>`
            ).catch(() => {});
            return;
        }

        const mensajeErrorFinal = 
            `❌ <b>PAGO NO COMPLETADO EN TELCEL</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `⚠️ ▫️ No se pudo finalizar la transacción.\n\n` +
            `👉 <b>Toca /start para reiniciar.</b>`;

        if (ultimaCapturaError) {
            await ctx.replyWithPhoto({ source: ultimaCapturaError }, {
                caption: mensajeErrorFinal.slice(0, 1024),
                parse_mode: 'HTML'
            }).catch(async () => {
                await ctx.replyWithHTML(mensajeErrorFinal);
            });
        } else {
            await ctx.replyWithHTML(mensajeErrorFinal);
        }
    } finally {
        logTelcel(id, `🧹 Cerrando sesión Telcel en finally global`);
        await cerrarSesionNavegador(id);
    }
}


// ==============================================================================
// 🔵 6. MÓDULO BAIT ($200, $230, $300) — ARQUITECTURA REFACTORIZADA LIMPIA
// ==============================================================================
const BAIT_SEL = {
  MODAL: 'dialog[open], div[role="dialog"]:has-text("Mi Bait")',
  TEL: 'app-o-input[formcontrolname="baitNumber"] input, input[name="phone"], input[placeholder*="teléfono" i], input[placeholder*="número" i]',
  CORREO: 'app-o-input[formcontrolname="email"] input, input[name="email"], input[placeholder*="Correo" i]',
  BOTON_AVANCE_NEGRO: [
    'button.bg-black:has-text("Siguiente")',
    'button:has-text("Siguiente")',
    'button[type="submit"]:has-text("Siguiente")'
  ],
  BOTON_AVANCE_AMARILLO: [
    'button.ph-bait-ex-85__submit-proxy:has-text("Continuar al pago")',
    'button:has-text("CONTINUAR AL PAGO")',
    'button:has-text("Continuar al pago")',
    'button[aria-label*="Continuar" i]',
    'button:has-text("Continuar")'
  ],
  PASARELA_PAYPAL: [
    'iframe[name*="paypal" i]',
    'iframe[src*="paypal" i]',
    '#paypal-button-container iframe',
    '[data-funding-source="paypal"]',
    'div.paypal-button[data-funding-source="paypal"]',
    '[aria-label*="PayPal" i]'
  ],
  BOTON_TARJETA: [
    'div[data-funding-source="card"]',
    'div[role="link"][data-funding-source="card"]',
    '[role="button"][data-funding-source="card"]',
    'div.paypal-button[data-funding-source="card"]',
    'div.paypal-button-black',
    'div.paypal-button-color-black',
    'span.paypal-button-text:has-text("Tarjeta de débito o crédito")',
    'span:has-text("Tarjeta de débito o crédito")',
    '[aria-label="Tarjeta de débito o crédito"]',
    '[aria-label*="Tarjeta" i]'
  ]
};

function getSelectoresPaqueteBait(monto = 300) {
    return [
        `app-card-recharge:has(img[alt*="${monto}" i]) button`,
        `app-card-recharge:has(img[src*="app-${monto}-card"]) button`,
        `app-card-recharge:has(img[src*="${monto}"]) button`,
        `app-card-recharge:has(img[alt*="${monto}" i])`,
        `app-card-recharge:has(img[src*="${monto}"])`,
        `img[alt*="${monto}" i]`,
        `img[src*="${monto}"]`
    ];
}

const navegadoresBait = new Map();
const popupsActivosBait = new Map();

// 1. CREACIÓN ÚNICA DE NAVEGADOR BAIT POR FLUJO
async function crearNavegadorBait(id) {
    await cerrarNavegadorBait(id);
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--no-first-run',
        '--lang=es-MX'
    ];

    let nav;
    const usarBrightData = !USE_LOCAL_CHROMIUM && Boolean(BRIGHTDATA_BROWSER_WS && (BRIGHTDATA_BROWSER_WS.startsWith('ws://') || BRIGHTDATA_BROWSER_WS.startsWith('wss://')));

    if (usarBrightData) {
        nav = await chromium.connectOverCDP(BRIGHTDATA_BROWSER_WS, { timeout: 35000 });
    } else {
        nav = await chromium.launch({ headless: ES_HEADLESS, slowMo: 0, timeout: 35000, args });
    }

    navegadoresBait.set(id, nav);
    return nav;
}

// 2. CREACIÓN DE CONTEXTO LIMPIO POR INTENTO
async function crearContextoBait(nav, id) {
    const geo = { latitude: 19.4326, longitude: -99.1332, accuracy: 100 };
    const contexto = await nav.newContext({
        locale: 'es-MX',
        timezoneId: 'America/Mexico_City',
        geolocation: geo,
        permissions: ['geolocation'],
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        extraHTTPHeaders: { 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8' }
    });

    await contexto.grantPermissions(['geolocation'], { origin: 'https://mibait.com' }).catch(() => {});
    await contexto.setGeolocation(geo).catch(() => {});

    const pag = await contexto.newPage();
    pag.setDefaultTimeout(15000);
    pag.setDefaultNavigationTimeout(30000);

    pag.on('dialog', async dialog => {
        await dialog.accept().catch(() => {});
    });

    contexto.on('page', async nuevaPag => {
        popupsActivosBait.set(id, nuevaPag);
    });

    pag.on('popup', async popup => {
        popupsActivosBait.set(id, popup);
    });

    return { contexto, pag };
}

// 3. CIERRE DE CONTEXTO POR INTENTO
async function cerrarContextoBait(contexto, id) {
    if (id && popupsActivosBait.has(id)) {
        const popup = popupsActivosBait.get(id);
        popupsActivosBait.delete(id);
        if (popup && !popup.isClosed()) {
            await popup.close().catch(() => {});
        }
    }
    if (contexto) {
        try {
            const pags = contexto.pages ? contexto.pages() : [];
            for (const p of pags) {
                await p.close().catch(() => {});
            }
            await contexto.close().catch(() => {});
        } catch {}
    }
}

// 4. CIERRE COMPLETO DEL NAVEGADOR BAIT
async function cerrarNavegadorBait(id) {
    if (id && popupsActivosBait.has(id)) {
        const popup = popupsActivosBait.get(id);
        popupsActivosBait.delete(id);
        if (popup && !popup.isClosed()) {
            await popup.close().catch(() => {});
        }
    }
    if (id && navegadoresBait.has(id)) {
        const nav = navegadoresBait.get(id);
        navegadoresBait.delete(id);
        try {
            const contextos = nav.contexts ? nav.contexts() : [];
            for (const ctx of contextos) {
                const pags = ctx.pages ? ctx.pages() : [];
                for (const p of pags) {
                    await p.close().catch(() => {});
                }
                await ctx.close().catch(() => {});
            }
            await nav.close().catch(() => {});
        } catch {}
    } else if (!id) {
        popupsActivosBait.clear();
        const navs = Array.from(navegadoresBait.values());
        navegadoresBait.clear();
        for (const nav of navs) {
            try {
                await nav.close().catch(() => {});
            } catch {}
        }
    }
    global.gc?.();
}

const cerrarBait = cerrarNavegadorBait;

const aceptarCookiesBait = async (pag, id) => {
    try {
        const selectoresCookies = [
            '#onetrust-accept-btn-handler',
            '#accept-recommended-btn-handler',
            'button:has-text("Aceptar todas las cookies")',
            'button:has-text("Aceptar todas")',
            'button:has-text("Aceptar cookies")',
            'button:has-text("Permitir todas")',
            'button:has-text("Permitir cookies")',
            'button:has-text("Aceptar")',
            'button:has-text("Acepto")',
            'button:has-text("Entendido")',
            'button:has-text("Continuar y aceptar")',
            'button[id*="cookie" i]',
            'button[class*="cookie" i]',
            '#ph71-close',
            'button.ph71-close',
            'button:has-text("✕")',
            'button:has-text("close")',
            'button[aria-label*="Cerrar aviso" i]',
            'button[aria-label*="Cerrar" i]',
            'button[aria-label*="Close" i]',
            'button[aria-label*="Cookies" i]',
            'button[aria-label*="Aceptar" i]'
        ];

        for (const s of selectoresCookies) {
            try {
                const btn = pag.locator(s).first();
                if (await btn.isVisible({ timeout: 150 }).catch(() => false)) {
                    await btn.click({ timeout: 400 }).catch(() => {});
                }
            } catch(e) {}
        }
    } catch {}
};

// 5. DETECCIÓN TEMPRANA DE ERROR BAIT VISIBLE
async function detectarErrorBaitVisible(pag, id) {
    if (!pag || (typeof pag.isClosed === 'function' && pag.isClosed())) return false;
    try {
        const errorDetectado = await pag.evaluate(() => {
            const esVisible = el => {
                if (!el) return false;
                const s = window.getComputedStyle(el);
                return s && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
            };

            const patrones = [
                'ocurrió un error, inténtalo de nuevo más tarde',
                'ocurrio un error, intentalo de nuevo mas tarde',
                'ocurrió un error',
                'ocurrio un error',
                'inténtalo de nuevo más tarde',
                'intentalo de nuevo mas tarde'
            ];

            const selectores = ['dialog[open]', '.modal.show', '.alert', 'div[role="alert"]', 'div[role="dialog"]', '.swal2-modal', '.error', '.error-container', 'body'];
            for (const sel of selectores) {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    if (sel === 'body' || esVisible(el)) {
                        const t = (el.innerText || '').toLowerCase();
                        for (const pat of patrones) {
                            if (t.includes(pat)) {
                                return true;
                            }
                        }
                    }
                }
            }
            return false;
        }).catch(() => false);

        if (errorDetectado) {
            console.log(`⚠️ [Bait Usuario ${id}] ERROR_BAIT_TEMPORAL — portal BAIT respondió con error visible`);
            return true;
        }
    } catch {}
    return false;
}

// 5.1 APERTURA DE PAQUETE, MODAL, LLENADO Y AVANCE
async function abrirPaqueteBait(pag, id, numero, correo, monto = 300) {
    // 1. Navegación inicial. No ocultamos el error: lo registramos y dejamos que
    // la comprobación visual decida si la SPA de BAIT terminó de renderizar.
    let respuestaHome = null;
    try {
        respuestaHome = await pag.goto(URL_BAIT, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log(`🌐 [Bait Usuario ${id}] HOME BAIT HTTP ${respuestaHome ? respuestaHome.status() : 'SIN_STATUS'} — ${pag.url()}`);
    } catch (eGoto) {
        console.log(`⚠️ [Bait Usuario ${id}] Navegación inicial BAIT incompleta: ${(eGoto.message || eGoto).toString().slice(0, 180)}`);
    }

    await aceptarCookiesBait(pag, id);

    // Comprobación temprana después de goto
    if (await detectarErrorBaitVisible(pag, id)) {
        const err = new Error("ERROR_BAIT_TEMPORAL");
        err.codigo = "ERROR_BAIT_TEMPORAL";
        throw err;
    }

    // 2. Esperar la HOME real de BAIT. Antes dependía exclusivamente de
    // <app-card-recharge>; ahora también aceptamos como señal válida que el
    // paquete solicitado ya sea visible, por si BAIT cambia el wrapper Angular.
    const tInicioHome = Date.now();
    const TIMEOUT_HOME_MS = 20000;
    let homeCargo = false;
    let senalHome = 'NINGUNA';
    const selectoresPaqueteHome = getSelectoresPaqueteBait(monto);

    while (Date.now() - tInicioHome < TIMEOUT_HOME_MS) {
        if (await detectarErrorBaitVisible(pag, id)) {
            const err = new Error("ERROR_BAIT_TEMPORAL");
            err.codigo = "ERROR_BAIT_TEMPORAL";
            throw err;
        }

        const countCards = await pag.locator('app-card-recharge').count().catch(() => 0);
        if (countCards > 0) {
            const primerCard = pag.locator('app-card-recharge').first();
            if (await primerCard.isVisible({ timeout: 120 }).catch(() => false)) {
                homeCargo = true;
                senalHome = 'APP_CARD_RECHARGE';
                break;
            }
        }

        // Fallback conservador: si el wrapper cambió pero la tarjeta/imagen del
        // monto solicitado sí está visible, la HOME está cargada y podemos seguir.
        for (const sel of selectoresPaqueteHome) {
            const visible = await pag.locator(sel).first().isVisible({ timeout: 80 }).catch(() => false);
            if (visible) {
                homeCargo = true;
                senalHome = `PAQUETE_VISIBLE:${sel}`;
                break;
            }
        }
        if (homeCargo) break;

        await aceptarCookiesBait(pag, id);
        await pag.waitForTimeout(250);
    }

    if (homeCargo) {
        console.log(`✅ [Bait Usuario ${id}] HOME BAIT detectada en ${Date.now() - tInicioHome} ms (${senalHome})`);
    }

    if (!homeCargo) {
        if (await detectarErrorBaitVisible(pag, id)) {
            const err = new Error("ERROR_BAIT_TEMPORAL");
            err.codigo = "ERROR_BAIT_TEMPORAL";
            throw err;
        }

        // Diagnóstico antes de cerrar el intento. Esto permite distinguir si BAIT
        // respondió con otra pantalla, quedó en blanco o cambió la estructura.
        const diagHome = await (async () => {
            const url = pag.url();
            const titulo = await pag.title().catch(() => '');
            const texto = await pag.locator('body').innerText({ timeout: 800 }).catch(() => '');
            const muestra = texto.replace(/\s+/g, ' ').trim().slice(0, 500);
            const cardsDom = await pag.locator('app-card-recharge').count().catch(() => 0);
            return { url, titulo, muestra, cardsDom };
        })().catch(() => ({ url: pag.url(), titulo: '', muestra: '', cardsDom: 0 }));

        console.log(`🔎 [Bait Usuario ${id}] DIAGNÓSTICO HOME — URL: ${diagHome.url}`);
        console.log(`🔎 [Bait Usuario ${id}] DIAGNÓSTICO HOME — Título: ${diagHome.titulo || 'SIN_TITULO'} | app-card-recharge DOM: ${diagHome.cardsDom}`);
        console.log(`🔎 [Bait Usuario ${id}] DIAGNÓSTICO HOME — Texto visible: ${diagHome.muestra || 'SIN_TEXTO_VISIBLE'}`);

        const err = new Error("BAIT_HOME_NO_CARGO");
        err.codigo = "BAIT_HOME_NO_CARGO";
        err.diagnosticoHome = diagHome;
        throw err;
    }

    // 3. Localizar paquete de recarga ($300)
    const selectoresCard = getSelectoresPaqueteBait(monto);
    let cardBtn = null;
    const tInicioPaquete = Date.now();
    const TIMEOUT_PAQUETE_MS = 10000;

    while (Date.now() - tInicioPaquete < TIMEOUT_PAQUETE_MS) {
        if (await detectarErrorBaitVisible(pag, id)) {
            const err = new Error("ERROR_BAIT_TEMPORAL");
            err.codigo = "ERROR_BAIT_TEMPORAL";
            throw err;
        }

        for (const sel of selectoresCard) {
            try {
                const el = pag.locator(sel).first();
                if (await el.isVisible({ timeout: 80 }).catch(() => false)) {
                    cardBtn = el;
                    break;
                }
            } catch(e) {}
        }
        if (cardBtn) break;
        await pag.waitForTimeout(200);
    }

    if (!cardBtn) {
        if (await detectarErrorBaitVisible(pag, id)) {
            const err = new Error("ERROR_BAIT_TEMPORAL");
            err.codigo = "ERROR_BAIT_TEMPORAL";
            throw err;
        }
        const err = new Error("PAQUETE_BAIT_NO_VISIBLE");
        err.codigo = "PAQUETE_BAIT_NO_VISIBLE";
        throw err;
    }

    await cardBtn.scrollIntoViewIfNeeded().catch(() => {});
    await cardBtn.click().catch(() => cardBtn.click({ force: true }));

    // 4. Detectar apertura del modal mediante dialog[open]
    const modal = pag.locator('dialog[open]').first();
    const tInicioModal = Date.now();
    const TIMEOUT_MODAL_MS = 10000;
    let modalAbierto = false;

    while (Date.now() - tInicioModal < TIMEOUT_MODAL_MS) {
        if (await detectarErrorBaitVisible(pag, id)) {
            const err = new Error("ERROR_BAIT_TEMPORAL");
            err.codigo = "ERROR_BAIT_TEMPORAL";
            throw err;
        }
        if (await modal.isVisible({ timeout: 80 }).catch(() => false)) {
            modalAbierto = true;
            break;
        }
        await pag.waitForTimeout(150);
    }

    if (!modalAbierto) {
        if (await detectarErrorBaitVisible(pag, id)) {
            const err = new Error("ERROR_BAIT_TEMPORAL");
            err.codigo = "ERROR_BAIT_TEMPORAL";
            throw err;
        }
        const err = new Error("MODAL_BAIT_NO_ABRIO");
        err.codigo = "MODAL_BAIT_NO_ABRIO";
        throw err;
    }

    // Comprobación de error visible después de abrir el modal
    if (await detectarErrorBaitVisible(pag, id)) {
        const err = new Error("ERROR_BAIT_TEMPORAL");
        err.codigo = "ERROR_BAIT_TEMPORAL";
        throw err;
    }

    // 5. Llenar teléfono y correo con tipeo de teclado
  const inputTel = modal.locator(BAIT_SEL.TEL).first();

await inputTel.waitFor({
    state: 'visible',
    timeout: 8000
});

const numeroBait = String(numero || '')
    .replace(/\D/g, '')
    .slice(0, 10);

if (numeroBait.length !== 10) {
    throw new Error(
        `NUMERO_BAIT_LONGITUD_INVALIDA_${numeroBait.length}`
    );
}

await inputTel.scrollIntoViewIfNeeded().catch(() => {});
await inputTel.click({ force: true });
await inputTel.fill('');

await pag.waitForTimeout(200);

console.log(
    `[BAIT DEBUG] antes de escribir:`,
    await inputTel.inputValue().catch(() => 'ERROR')
);

await inputTel.fill(numeroBait);

await inputTel.dispatchEvent(
    'input',
    { bubbles: true }
).catch(() => {});

await inputTel.dispatchEvent(
    'change',
    { bubbles: true }
).catch(() => {});

await pag.waitForTimeout(300);

let valorTelefono =
    String(
        await inputTel.inputValue().catch(() => '')
    ).replace(/\D/g, '');

console.log(
    `[BAIT DEBUG] teléfono esperado=${numeroBait} valorReal=${valorTelefono} longitud=${valorTelefono.length}`
);

if (valorTelefono !== numeroBait) {

    await inputTel.click({ force: true });
    await inputTel.fill('');

    await inputTel.evaluate(
        (el, valor) => {
            const setter =
                Object.getOwnPropertyDescriptor(
                    HTMLInputElement.prototype,
                    'value'
                )?.set;

            if (setter) {
                setter.call(el, valor);
            } else {
                el.value = valor;
            }

            el.dispatchEvent(
                new Event('input', { bubbles: true })
            );

            el.dispatchEvent(
                new Event('change', { bubbles: true })
            );
        },
        numeroBait
    );

    await pag.waitForTimeout(300);

    valorTelefono =
        String(
            await inputTel.inputValue().catch(() => '')
        ).replace(/\D/g, '');

    console.log(
        `[BAIT DEBUG] segundo intento valorReal=${valorTelefono} longitud=${valorTelefono.length}`
    );
}

if (valorTelefono !== numeroBait) {
    throw new Error(
        `BAIT_TELEFONO_NO_SE_ESCRIBIO_COMPLETO_${valorTelefono.length}_DE_10`
    );
}

await inputTel.dispatchEvent(
    'blur',
    { bubbles: true }
).catch(() => {});

console.log(
    `[Bait Usuario ${id}] ✅ Teléfono BAIT escrito correctamente (10/10)`
);

const inputMail = modal.locator(BAIT_SEL.CORREO).first();

await inputMail.waitFor({
    state: 'visible',
    timeout: 8000
});

const correoBait = String(correo || '').trim();

if (
    !correoBait ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correoBait)
) {
    throw new Error('CORREO_BAIT_INVALIDO');
}

await inputMail.scrollIntoViewIfNeeded().catch(() => {});
await inputMail.click({ force: true });
await inputMail.fill('');

await pag.waitForTimeout(200);

console.log(
    `[BAIT DEBUG] correo antes de escribir:`,
    await inputMail.inputValue().catch(() => 'ERROR')
);

// Primer intento
await inputMail.fill(correoBait);

await inputMail.dispatchEvent(
    'input',
    { bubbles: true }
).catch(() => {});

await inputMail.dispatchEvent(
    'change',
    { bubbles: true }
).catch(() => {});

await pag.waitForTimeout(300);

let valorCorreo =
    String(
        await inputMail.inputValue().catch(() => '')
    ).trim();

console.log(
    `[BAIT DEBUG] correo esperado=${correoBait} valorReal=${valorCorreo}`
);

// Segundo intento si BAIT lo borró
if (valorCorreo !== correoBait) {

    console.log(
        `[Bait Usuario ${id}] ⚠️ Correo no quedó escrito. Reintentando...`
    );

    await inputMail.click({ force: true });
    await inputMail.fill('');

    await inputMail.evaluate(
        (el, valor) => {

            const setter =
                Object.getOwnPropertyDescriptor(
                    HTMLInputElement.prototype,
                    'value'
                )?.set;

            if (setter) {
                setter.call(el, valor);
            } else {
                el.value = valor;
            }

            el.dispatchEvent(
                new Event('input', { bubbles: true })
            );

            el.dispatchEvent(
                new Event('change', { bubbles: true })
            );

        },
        correoBait
    );

    await pag.waitForTimeout(300);

    valorCorreo =
        String(
            await inputMail.inputValue().catch(() => '')
        ).trim();

    console.log(
        `[BAIT DEBUG] segundo intento correo=${valorCorreo}`
    );
}

if (valorCorreo !== correoBait) {
    throw new Error(
        'BAIT_CORREO_NO_SE_ESCRIBIO_CORRECTAMENTE'
    );
}

await inputMail.dispatchEvent(
    'blur',
    { bubbles: true }
).catch(() => {});

console.log(
    `[Bait Usuario ${id}] ✅ Correo BAIT escrito correctamente`
);
    await pag.waitForTimeout(400);

    const verifNumBait = await detectarNumeroInvalido(pag);
    if (verifNumBait && verifNumBait.esInvalido) {
        const err = new Error("NUMERO_INVALIDO");
        err.codigo = "NUMERO_INVALIDO";
        err.esNumeroInvalido = true;
        err.mensajeInvalido = verifNumBait.mensaje;
        throw err;
    }

    // Comprobar error BAIT tras llenar datos
    if (await detectarErrorBaitVisible(pag, id)) {
        const err = new Error("ERROR_BAIT_TEMPORAL");
        err.codigo = "ERROR_BAIT_TEMPORAL";
        throw err;
    }

    // 6. Detectar y esperar a que el botón de avance se habilite naturalmente
    const inicioEsperaAvance = Date.now();
    const TIMEOUT_AVANCE_MS = 15000;
    let btnEncontrado = null;
    let logueadoBotonDeshabilitado = false;

    while (Date.now() - inicioEsperaAvance < TIMEOUT_AVANCE_MS) {
        const verifLoop = await detectarNumeroInvalido(pag);
        if (verifLoop && verifLoop.esInvalido) {
            const err = new Error("NUMERO_INVALIDO");
            err.codigo = "NUMERO_INVALIDO";
            err.esNumeroInvalido = true;
            err.mensajeInvalido = verifLoop.mensaje;
            throw err;
        }

        if (await detectarErrorBaitVisible(pag, id)) {
            const err = new Error("ERROR_BAIT_TEMPORAL");
            err.codigo = "ERROR_BAIT_TEMPORAL";
            throw err;
        }

        for (const sel of BAIT_SEL.BOTON_AVANCE_AMARILLO) {
            try {
                const b = pag.locator(sel).first();
                if (await b.isVisible({ timeout: 50 }).catch(() => false)) {
                    btnEncontrado = b;
                    break;
                }
            } catch(e) {}
        }

        if (!btnEncontrado) {
            for (const sel of BAIT_SEL.BOTON_AVANCE_NEGRO) {
                try {
                    const b = modal.locator(sel).first();
                    if (await b.isVisible({ timeout: 50 }).catch(() => false)) {
                        btnEncontrado = b;
                        break;
                    }
                } catch(e) {}
            }
        }

        if (btnEncontrado) {
            await btnEncontrado.scrollIntoViewIfNeeded().catch(() => {});
            const habilitado = await btnEncontrado.isEnabled().catch(() => false);
            if (habilitado) {
                await btnEncontrado.click();
                await pag.waitForTimeout(600);

                const verifPostClick = await detectarNumeroInvalido(pag);
                if (verifPostClick && verifPostClick.esInvalido) {
                    const err = new Error("NUMERO_INVALIDO");
                    err.codigo = "NUMERO_INVALIDO";
                    err.esNumeroInvalido = true;
                    err.mensajeInvalido = verifPostClick.mensaje;
                    throw err;
                }

                return true;
            } else {
                if (!logueadoBotonDeshabilitado) {
                    logueadoBotonDeshabilitado = true;
                    console.log(`[Bait Usuario ${id}] BOTON_AVANCE_VISIBLE=true`);
                    console.log(`[Bait Usuario ${id}] BOTON_AVANCE_ENABLED=false`);
                }
                // NO usar force:true para intentar saltarse un botón deshabilitado
                btnEncontrado = null;
            }
        }

        await pag.waitForTimeout(150);
    }

    const verifFinal = await detectarNumeroInvalido(pag);
    if (verifFinal && verifFinal.esInvalido) {
        const err = new Error("NUMERO_INVALIDO");
        err.codigo = "NUMERO_INVALIDO";
        err.esNumeroInvalido = true;
        err.mensajeInvalido = verifFinal.mensaje;
        throw err;
    }

    if (await detectarErrorBaitVisible(pag, id)) {
        const err = new Error("ERROR_BAIT_TEMPORAL");
        err.codigo = "ERROR_BAIT_TEMPORAL";
        throw err;
    }

    const err = new Error("BOTON_AVANCE_NO_HABILITADO");
    err.codigo = "BOTON_AVANCE_NO_HABILITADO";
    throw err;
}

function truncar(str, max = 180) {
    if (!str) return '';
    const limpio = String(str).replace(/\s+/g, ' ').trim();
    return limpio.length > max ? limpio.slice(0, max) + '...' : limpio;
}

function esFramePrerender(f) {
    if (!f) return false;
    const name = (f.name() || '').toLowerCase();
    const url = (f.url() || '').toLowerCase();
    if (name.includes('prerender') || name.includes('__zoid_prerender_frame__')) {
        return true;
    }
    if (url === 'about:blank' && name.includes('prerender')) {
        return true;
    }
    return false;
}

// 5.2 ESPERA EXPLÍCITA Y DIAGNÓSTICO DE TRANSICIÓN INTERMEDIA (MÁXIMO 15s ESTRICTO, POLLING: 200ms)
async function esperarFinPantallaIntermediaBait(pag, id) {
    const t0 = Date.now();
    const TIMEOUT_INTERMEDIO_MS = 15000;
    let modalRegistroDetectado = false;
    let ultimoEstadoTransicion = '';

    while (Date.now() - t0 < TIMEOUT_INTERMEDIO_MS) {
        if (Date.now() - t0 >= TIMEOUT_INTERMEDIO_MS) break;

        const transcurrido = Date.now() - t0;
        const contexto = pag.context();
        const paginas = contexto && contexto.pages ? contexto.pages() : [pag];
        const numPags = paginas.length;
        const popup = popupsActivosBait.get(id);
        const paginasARevisar = (popup && !popup.isClosed() && !paginas.includes(popup))
            ? [...paginas, popup]
            : paginas;

        let framesTotales = [];
        for (const p of paginasARevisar) {
            const pFrames = p.frames ? p.frames() : [p];
            framesTotales.push(...pFrames);
        }

        const numFrames = framesTotales.length;
        const urlActual = pag.url() || '';

        // 1. PRIORIDAD 1: COMPROBAR SI YA EXISTE UN FRAME ACTIVO DE PAYPAL (PRIORIDAD ABSOLUTA)
        let ppFrameActivo = false;
        for (const f of framesTotales) {
            if (esFramePrerender(f)) continue;
            const fUrl = (f.url() || '').toLowerCase();
            const fName = (f.name() || '').toLowerCase();

            if (fUrl.includes('paypal.com/smart/buttons') || fUrl.includes('smart/buttons') || fName.includes('paypal_buttons') || fUrl.includes('paypal.com/smart/card-fields') || fUrl.includes('smart/card-fields')) {
                ppFrameActivo = true;
                break;
            }
        }

        if (ppFrameActivo) {
            console.log(`✅ [Bait Usuario ${id}] PAYPAL ACTIVO — ignorando texto residual del modal`);
            console.log(`ESTADO_TRANSICION: PAYPAL_VISIBLE`);
            return { estado: 'OK', pasarela: 'PAYPAL' };
        }

        if (Date.now() - t0 >= TIMEOUT_INTERMEDIO_MS) break;

        // 2. PRIORIDAD 2: COMPROBAR SI YA EXISTE UN FRAME ACTIVO DE CONEKTA
        let ckFrameActivo = false;
        for (const f of framesTotales) {
            if (esFramePrerender(f)) continue;
            const fUrl = (f.url() || '').toLowerCase();
            const fName = (f.name() || '').toLowerCase();

            if (fName.includes('conekta_embedded_checkout') || fUrl.includes('conekta') || fName.includes('conekta')) {
                ckFrameActivo = true;
                break;
            }
        }

        if (ckFrameActivo) {
            console.log(`⚠️ [Bait Usuario ${id}] CONEKTA ACTIVO — ignorando texto residual del modal`);
            console.log(`ESTADO_TRANSICION: CONEKTA_VISIBLE`);
            return { estado: 'OK', pasarela: 'CONEKTA' };
        }

        if (Date.now() - t0 >= TIMEOUT_INTERMEDIO_MS) break;

        // 3. COMPROBACIÓN TEMPRANA DE ERROR BAIT VISIBLE DENTRO DE LA ESPERA INTERMEDIA
        if (await detectarErrorBaitVisible(pag, id)) {
            return {
                estado: 'ERROR_BAIT_TEMPORAL',
                subtipo: 'PORTAL_BAIT_NO_DISPONIBLE',
                exito: false,
                pagoConfirmado: false
            };
        }

        if (Date.now() - t0 >= TIMEOUT_INTERMEDIO_MS) break;

        // 4. PRIORIDAD 4: COMPROBAR SI EXISTE UN CONTENEDOR VISIBLE REAL DEL MODAL REGISTRA TU LÍNEA
        const modalRealmenteVisible = await pag.evaluate(() => {
            const esVisible = el => {
                if (!el) return false;
                const s = window.getComputedStyle(el);
                return s && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
            };

            const selectoresModal = ['dialog[open]', '.modal.show', 'div[role="dialog"]', 'div.modal', 'app-modal', 'app-dialog', '[class*="modal-dialog" i]'];
            for (const sel of selectoresModal) {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    if (esVisible(el)) {
                        const t = (el.innerText || '').toLowerCase();
                        if (t.includes('registra tu línea') || t.includes('registra tu linea')) {
                            return true;
                        }
                    }
                }
            }
            return false;
        }).catch(() => false);

        if (modalRealmenteVisible) {
            if (!modalRegistroDetectado) {
                modalRegistroDetectado = true;
                console.log(`🟡 [Bait Usuario ${id}] Modal REGISTRA TU LÍNEA detectado`);
                console.log(`ESTADO_TRANSICION: MODAL_REGISTRO`);
            }

            const estadoResumen = `modal=true|frms=${numFrames}`;
            if (estadoResumen !== ultimoEstadoTransicion) {
                ultimoEstadoTransicion = estadoResumen;
                console.log(`⏳ [Bait Usuario ${id}] Esperando que termine modal REGISTRA TU LÍNEA (${transcurrido} ms)`);
                console.log(`🌐 URL: ${truncar(urlActual)} | 📄 Páginas: ${numPags} | 🧩 Frames: ${numFrames}`);
            }

            if (Date.now() - t0 >= TIMEOUT_INTERMEDIO_MS) break;
            await pag.waitForTimeout(200);
            continue;
        }

        if (Date.now() - t0 >= TIMEOUT_INTERMEDIO_MS) break;

        // Si el modal estuvo visible y ahora desapareció
        if (modalRegistroDetectado && !modalRealmenteVisible) {
            console.log(`✅ [Bait Usuario ${id}] Modal REGISTRA TU LÍNEA desapareció — buscando pasarela`);
            console.log(`ESTADO_TRANSICION: ESPERANDO_PASARELA`);

            // Re-enumerar frames inmediatamente
            const ctx2 = pag.context();
            const pags2 = ctx2 ? ctx2.pages() : [pag];
            let ppPost = false;
            let ckPost = false;

            for (const p of pags2) {
                const frms = p.frames ? p.frames() : [p];
                for (const f of frms) {
                    if (esFramePrerender(f)) continue;
                    const u = (f.url() || '').toLowerCase();
                    const n = (f.name() || '').toLowerCase();
                    if (u.includes('smart/buttons') || n.includes('paypal_buttons') || u.includes('smart/card-fields')) ppPost = true;
                    if (n.includes('conekta_embedded_checkout') || u.includes('conekta') || n.includes('conekta')) ckPost = true;
                }
            }

            if (ppPost) {
                console.log(`✅ [Bait Usuario ${id}] Transición terminó en PAYPAL`);
                console.log(`ESTADO_TRANSICION: PAYPAL_VISIBLE`);
                return { estado: 'OK', pasarela: 'PAYPAL' };
            } else if (ckPost) {
                console.log(`⚠️ [Bait Usuario ${id}] Transición terminó en CONEKTA`);
                console.log(`ESTADO_TRANSICION: CONEKTA_VISIBLE`);
                return { estado: 'OK', pasarela: 'CONEKTA' };
            } else {
                return { estado: 'OK', pasarela: 'DESCONOCIDA' };
            }
        }

        // 5. TRANSICIÓN / CARGA GENERAL
        const estadoResumen = `modal=false|frms=${numFrames}`;
        if (estadoResumen !== ultimoEstadoTransicion) {
            ultimoEstadoTransicion = estadoResumen;
            console.log(`⏳ [Bait Usuario ${id}] Transición todavía cargando (${transcurrido} ms)...`);
            console.log(`🌐 URL: ${truncar(urlActual)} | 📄 Páginas: ${numPags} | 🧩 Frames: ${numFrames}`);
        }

        if (Date.now() - t0 >= TIMEOUT_INTERMEDIO_MS) break;
        await pag.waitForTimeout(200);
    }

    // Salida estricta a los 15s:
    const duracion = Date.now() - t0;
    const urlFinal = pag.url() || '';
    const framesFinales = pag.frames ? pag.frames().map(f => truncar(f.name(), 30)).filter(Boolean) : [];

    if (modalRegistroDetectado) {
        console.log(`⚠️ [Bait Usuario ${id}] MODAL REGISTRA TU LÍNEA ATASCADO`);
        console.log(`Tiempo: ${duracion} ms`);
        console.log(`Frames: ${framesFinales.length} (${framesFinales.join(', ')})`);
        console.log(`URL: ${truncar(urlFinal)}`);
        console.log(`ESTADO_TRANSICION: MODAL_ATASCADO`);

        return {
            estado: 'MODAL_REGISTRO_ATASCADO',
            subtipo: 'BAIT_TRANSICION_NO_TERMINO',
            exito: false,
            pagoConfirmado: false
        };
    }

    console.log(`⚠️ [Bait Usuario ${id}] Pantalla intermedia concluyó por timeout de ${duracion} ms`);
    return { estado: 'TIMEOUT', exito: false, pagoConfirmado: false };
}

async function detectarPasarelaBait(pag, id, intento = 1) {
    console.log(`🔎 [Bait Usuario ${id}] Procesando detección interna...`);

    const inicio = Date.now();
    const TIMEOUT_DETECCION_MS = 5000;

    while (Date.now() - inicio < TIMEOUT_DETECCION_MS) {
        const contexto = pag.context();
        const paginasActivas = contexto ? contexto.pages() : [pag];

        const popup = popupsActivosBait.get(id);

        const paginasARevisar =
            popup &&
            !popup.isClosed() &&
            !paginasActivas.includes(popup)
                ? [...paginasActivas, popup]
                : paginasActivas;

        // =====================================================
        // 1. PAYPAL — PRIORIDAD MÁXIMA
        // =====================================================
        for (const p of paginasARevisar) {
            const frames = p.frames ? p.frames() : [p];

            for (const f of frames) {
                if (esFramePrerender(f)) continue;

                const fUrl = String(f.url() || '').toLowerCase();
                const fName = String(f.name() || '').toLowerCase();

                const esPayPal =
                    fUrl.includes('paypal.com/smart/buttons') ||
                    fUrl.includes('smart/buttons') ||
                    fUrl.includes('paypal.com/smart/card-fields') ||
                    fUrl.includes('smart/card-fields') ||
                    fName.includes('paypal_buttons') ||
                    fName.includes('paypal_card_form');

                if (esPayPal) {
                    const tiempo = Date.now() - inicio;

                    console.log(
                        `✅ [Bait Usuario ${id}] PAYPAL confirmado en ${tiempo} ms`
                    );

                    return {
                        pasarela: 'PAYPAL',
                        confirmada: true
                    };
                }
            }
        }

        // =====================================================
        // 2. CONEKTA
        // =====================================================
        for (const p of paginasARevisar) {
            const frames = p.frames ? p.frames() : [p];

            for (const f of frames) {
                if (esFramePrerender(f)) continue;

                const fUrl = String(f.url() || '').toLowerCase();
                const fName = String(f.name() || '').toLowerCase();

                const esConekta =
                    fUrl.includes('conekta') ||
                    fName.includes('conekta') ||
                    fName.includes('conekta_embedded_checkout');

                if (esConekta) {
                    const tiempo = Date.now() - inicio;

                    console.log(
                        `🟠 [Bait Usuario ${id}] CONEKTA confirmada en ${tiempo} ms`
                    );

                    return {
                        estado: 'PASARELA_NO_ADMITIDA',
                        pasarela: 'CONEKTA',
                        confirmada: true,
                        exito: false,
                        pagoConfirmado: false
                    };
                }
            }
        }

        // =====================================================
        // 3. OPENPAY
        // =====================================================
        for (const p of paginasARevisar) {
            const openPayVisible = await p
                .locator(
                    'o-payment-gateway, .payment-gateway-container'
                )
                .first()
                .isVisible({
                    timeout: 80
                })
                .catch(() => false);

            if (openPayVisible) {
                const tiempo = Date.now() - inicio;

                console.log(
                    `🔵 [Bait Usuario ${id}] OPENPAY confirmado en ${tiempo} ms`
                );

                return {
                    estado: 'PASARELA_NO_ADMITIDA',
                    pasarela: 'OPENPAY',
                    confirmada: true,
                    exito: false,
                    pagoConfirmado: false
                };
            }
        }

        // Todavía está cargando.
        // Revisar otra vez rápidamente.
        await pag.waitForTimeout(150);
    }

    const tiempoTotal = Date.now() - inicio;

    console.log(
        `⏱️ [Bait Usuario ${id}] No se confirmó pasarela en ${tiempoTotal} ms`
    );

    return {
        estado: 'PASARELA_NO_DETERMINADA',
        pasarela: 'TIMEOUT',
        confirmada: false,
        exito: false,
        pagoConfirmado: false
    };
}
// 7. DIAGNÓSTICO Y ELEMENTOS INTERNOS DE PAYPAL
async function paso3DiagnosticoYElementosPayPalBait(pag, id, datos, monto = 300) {
    const popup = popupsActivosBait.get(id);
    const target = (popup && !popup.isClosed()) ? popup : pag;
    const contexto = pag.context();
    const paginasActivas = contexto ? contexto.pages() : [pag];
    const framesTotales = target.frames ? target.frames() : [];
    const framesPayPal = framesTotales.filter(f => !esFramePrerender(f) && ((f.url() || '').toLowerCase().includes('paypal') || (f.name() || '').toLowerCase().includes('paypal')));
    const textoVisible = await target.evaluate(() => (document.body ? document.body.innerText : '') || '').catch(() => '');
    const lineasPayPal = textoVisible.split('\n').map(l => l.trim()).filter(l => /paypal|tarjeta|pago/i.test(l)).join(' | ').slice(0, 180);

    console.log("==================================================");
    console.log(`[Bait Usuario ${id}] PASO 1 OK`);
    console.log(`[Bait Usuario ${id}] PASO 2 OK — PAYPAL DETECTADO`);
    console.log(`[Bait Usuario ${id}] URL: ${truncar(target.url())}`);
    console.log(`[Bait Usuario ${id}] cantidad de páginas: ${paginasActivas.length}`);
    console.log(`[Bait Usuario ${id}] cantidad de frames: ${framesTotales.length}`);
    console.log(`[Bait Usuario ${id}] frames relacionados con PayPal (${framesPayPal.length}):`, framesPayPal.map(f => ({ name: truncar(f.name(), 50), url: truncar(f.url(), 80) })));
    console.log(`[Bait Usuario ${id}] texto visible relacionado con PayPal: "${lineasPayPal}"`);
    console.log("==================================================");

    try {
        await paso3HacerClicTarjetaBait(pag, id, 'PAYPAL');
        await verificarCheckoutTarjetaConfirmado(pag, id);

        // Proceder al llenado de tarjeta y confirmación del pago en PayPal
        console.log(`[Bait Usuario ${id}] 💳 PASO 3: Llenando datos de tarjeta en PayPal y procesando pago...`);
        await paso3LlenarTarjetaYConfirmarBait(pag, id, datos);

        console.log(`[Bait Usuario ${id}] 🚀 PASO 4: Confirmando términos y realizando clic en PAGAR AHORA...`);
        const resultadoCobro = await paso3ConfirmarTerminosYPagarAhoraBait(pag, id, monto);

        return {
            exito: resultadoCobro.exito,
            pagoConfirmado: resultadoCobro.pagoConfirmado,
            pasarela: 'PAYPAL',
            pasarelaConfirmada: true,
            tipoResultado: 'RESULTADO_PAGO',
            clasificacion: resultadoCobro.clasificacion,
            textoLeido: resultadoCobro.textoLeido,
            captura: resultadoCobro.captura || null
        };
    } catch (errInterno) {
        console.log(`[Bait Usuario ${id}] ⚠️ Detalle en interacción interna PayPal: ${errInterno.message}.`);
        return {
            exito: false,
            pagoConfirmado: false,
            pasarela: 'PAYPAL',
            pasarelaConfirmada: true,
            tipoResultado: 'RESULTADO_PAGO',
            clasificacion: {
                estado: 'ERROR_PASARELA',
                subtipo: 'FALLO_INTERNO_PAYPAL',
                titulo: '⚠️ ERROR EN PROCESO DE PAGO',
                icono: '⚠️',
                explicacion: 'Ocurrió un error al procesar el pago en PayPal: ' + (errInterno.message || '')
            },
            textoLeido: errInterno.message || 'Error técnico en pasarela'
        };
    }
}

async function paso3HacerClicTarjetaBait(pag, id, pasarela = 'PAYPAL') {
    if (pasarela !== 'PAYPAL') {
        console.log(`[Bait Usuario ${id}] ⚠️ Protección: Pasarela no es PayPal (${pasarela}). Abortando.`);
        throw new Error("PAYPAL_REQUERIDO");
    }

    console.log(`[Bait Usuario ${id}] 🔍 PASO 3: Localizando botón de tarjeta dentro del frame activo de PayPal...`);
    const inicio = Date.now();
    const TIMEOUT_TARJETA_MS = 20000;
    let clickRealizado = false;

    while (Date.now() - inicio < TIMEOUT_TARJETA_MS) {
        const contexto = pag.context();
        const paginas = contexto && contexto.pages ? contexto.pages() : [pag];
        const popup = popupsActivosBait.get(id);
        if (popup && !popup.isClosed() && !paginas.includes(popup)) {
            paginas.push(popup);
        }

        let todosLosFrames = [];
        for (const p of paginas) {
            const pFrames = p.frames ? p.frames() : [p];
            todosLosFrames.push(...pFrames);
        }

        // 1. Filtrar frames válidos: deben ser smart/buttons y NO ser prerender
        const framesSmartButtons = todosLosFrames.filter(f => {
            if (esFramePrerender(f)) return false;
            const fUrl = (f.url() || '').toLowerCase();
            const fName = (f.name() || '').toLowerCase();
            return fUrl.includes('paypal.com/smart/buttons') || fUrl.includes('smart/buttons') || fName.includes('paypal_buttons');
        });

        for (const f of framesSmartButtons) {
            try {
                // Selector exacto del botón de tarjeta invitado
                const btn = f.locator('div[data-funding-source="card"]').first();
                const visible = await btn.isVisible({ timeout: 60 }).catch(() => false);
                if (!visible) continue;

                const enabled = await btn.isEnabled().catch(() => false);
                const box = await btn.boundingBox().catch(() => null);

                if (enabled && box && box.width > 0 && box.height > 0) {
                    console.log(`Frame estable: ${truncar(f.name() || 'principal')}`);
                    console.log(`URL estable: ${truncar(f.url())}`);
                    console.log(`Selector tarjeta visible: true`);
                    console.log(`Esperando estabilidad antes del clic...`);

                    // Ventana de estabilidad de 1000 ms (entre 800 y 1500 ms)
                    await pag.waitForTimeout(1000);

                    // Segunda comprobación de estabilidad
                    const fUrlActual = (f.url() || '').toLowerCase();
                    const frameSigueValido = !f.isDetached() && (fUrlActual.includes('smart/buttons') || fUrlActual.includes('paypal.com'));
                    const btnSigueVisible = await btn.isVisible().catch(() => false);
                    const box2 = await btn.boundingBox().catch(() => null);

                    if (frameSigueValido && btnSigueVisible && box2 && box2.width > 0 && box2.height > 0) {
                        await btn.scrollIntoViewIfNeeded().catch(() => {});
                        await btn.click({ force: false }).catch(() => btn.click({ force: true }));
                        clickRealizado = true;

                        console.log(`Clic único ejecutado`);
                        console.log(`Esperando paypal.com/smart/card-fields`);
                        break;
                    }
                }
            } catch (e) {}
        }

        if (clickRealizado) break;
        await pag.waitForTimeout(250);
    }

    if (!clickRealizado) {
        throw new Error("BOTON_TARJETA_PAYPAL_NO_ESTABLE");
    }

    return clickRealizado;
}

// 7.1 VERIFICACIÓN POST-CLIC DEL CHECKOUT DE TARJETA (ESPERA HASTA 10s)
async function verificarCheckoutTarjetaConfirmado(pag, id) {
    const inicio = Date.now();
    const TIMEOUT_POST_CLICK_MS = 10000;
    const SELECTORES_CHECKOUT = [
        'input#credit-card-number',
        'input[name="credit-card-number"]',
        'input[name="cardNumber"]',
        'input[autocomplete="cc-number"]',
        'input[placeholder*="tarjeta" i]',
        '#cardNumber',
        '#credit-card-number',
        'input#expiration-date',
        'input[name="expiry"]',
        'input#cvv',
        'input#csc',
        'input[name="cvv"]',
        'input#given-name',
        'input#firstName',
        'input#address-line1',
        'input#city',
        'input[name="city"]',
        'input#email',
        'input[name="email"]'
    ];

    let checkoutConfirmado = false;

    while (Date.now() - inicio < TIMEOUT_POST_CLICK_MS) {
        const contexto = pag.context();
        const paginas = contexto && contexto.pages ? contexto.pages() : [pag];
        const popup = popupsActivosBait.get(id);
        if (popup && !popup.isClosed() && !paginas.includes(popup)) {
            paginas.push(popup);
        }

        // 1. Detectar si se abrió una página normal externa de PayPal (login/checkout externo)
        for (const p of paginas) {
            const pUrl = (p.url() || '').toLowerCase();
            if (p !== pag && (pUrl.includes('paypal.com/signin') || pUrl.includes('paypal.com/checkoutnow') || pUrl.includes('paypal.com/cgi-bin'))) {
                console.log(`⚠️ [Bait Usuario ${id}] PAYPAL ABRIÓ FLUJO EXTERNO — CLIC REALIZADO DURANTE ESTADO NO ESTABLE`);
                throw new Error("PAYPAL_FLUJO_EXTERNO_NO_EMBEBIDO");
            }
        }

        // 2. Buscar evidencia del checkout embebido de invitado (smart/card-fields)
        for (const p of paginas) {
            const frames = p.frames ? p.frames() : [p];

            for (const f of frames) {
                if (esFramePrerender(f)) continue;

                const fUrl = (f.url() || '').toLowerCase();
                const fName = (f.name() || '').toLowerCase();

                if (fUrl.includes('paypal.com/smart/card-fields') || fUrl.includes('smart/card-fields') || fName.includes('paypal_card_form')) {
                    checkoutConfirmado = true;
                    break;
                }

                for (const sel of SELECTORES_CHECKOUT) {
                    try {
                        const el = f.locator(sel).first();
                        if (await el.isVisible({ timeout: 50 }).catch(() => false)) {
                            checkoutConfirmado = true;
                            break;
                        }
                    } catch(e) {}
                }
                if (checkoutConfirmado) break;
            }
            if (checkoutConfirmado) break;
        }

        if (checkoutConfirmado) break;
        await pag.waitForTimeout(250);
    }

    // Enumerar páginas y frames post-click
    const contexto = pag.context();
    const paginas = contexto && contexto.pages ? contexto.pages() : [pag];
    const popup = popupsActivosBait.get(id);
    if (popup && !popup.isClosed() && !paginas.includes(popup)) {
        paginas.push(popup);
    }

    for (const p of paginas) {
        console.log(`POST-CLICK PAGE -> url: ${truncar(p.url())}`);
        const frames = p.frames ? p.frames() : [];
        for (const f of frames) {
            console.log(`POST-CLICK FRAME -> name: ${truncar(f.name())}, url: ${truncar(f.url())}`);
        }
    }

    if (!checkoutConfirmado) {
        throw new Error("PAYPAL_CHECKOUT_TARJETA_NO_CONFIRMADO");
    }

    console.log(`✅ [Bait Usuario ${id}] PAYPAL CHECKOUT INVITADO DE TARJETA CONFIRMADO`);

    // Inspeccionar la presencia de cada campo sin interactuar ni rellenar
    let campoTarjeta = false;
    let campoVencimiento = false;
    let campoCsc = false;

    const selectoresNum = ['input#credit-card-number', 'input[name="credit-card-number"]', 'input[name="cardNumber"]', 'input[autocomplete="cc-number"]', 'input[placeholder*="tarjeta" i]', '#cardNumber', '#credit-card-number'];
    const selectoresExp = ['input#expiration-date', 'input[name="expiry"]', 'input[name="expiration-date"]', 'input[autocomplete="cc-exp"]'];
    const selectoresCsc = ['input#cvv', 'input#csc', 'input[name="cvv"]', 'input[name="csc"]', 'input[autocomplete="cc-csc"]'];

    for (const p of paginas) {
        const frames = p.frames ? p.frames() : [p];
        for (const f of frames) {
            if (esFramePrerender(f)) continue;

            for (const sel of selectoresNum) {
                if (await f.locator(sel).first().isVisible({ timeout: 25 }).catch(() => false)) {
                    campoTarjeta = true;
                    break;
                }
            }
            for (const sel of selectoresExp) {
                if (await f.locator(sel).first().isVisible({ timeout: 25 }).catch(() => false)) {
                    campoVencimiento = true;
                    break;
                }
            }
            for (const sel of selectoresCsc) {
                if (await f.locator(sel).first().isVisible({ timeout: 25 }).catch(() => false)) {
                    campoCsc = true;
                    break;
                }
            }
        }
    }

    console.log(`CHECKOUT_LISTO`);
    if (campoTarjeta) console.log(`CAMPO_TARJETA_VISIBLE`);
    if (campoVencimiento) console.log(`CAMPO_VENCIMIENTO_VISIBLE`);
    if (campoCsc) console.log(`CAMPO_CSC_VISIBLE`);

    return true;
}

async function paso3LlenarTarjetaYConfirmarBait(pag, id, datos) {
    const { cc, mes, anio, anioCompleto, cvv, nombre, direccion_valida, cp_auto, tel_auto, correo_auto, monto: montoIn } = datos;
    const monto = montoIn || 300;
    const dirInfo = direccion_valida || generarDireccionValida();

    await pag.waitForTimeout(1500);

    const popupPayPal = popupsActivosBait.get(id);
    const targetContext = (popupPayPal && !popupPayPal.isClosed()) ? popupPayPal : pag;

    if (popupPayPal && !popupPayPal.isClosed()) {
        console.log(`[Bait Usuario ${id}] 🪟 Operando dentro de la ventana emergente de pago con tarjeta`);
        await popupPayPal.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    }

    const framesPayPal = targetContext.frames ? targetContext.frames().filter(f => !esFramePrerender(f) && ((f.url() || '').toLowerCase().includes('paypal') || (f.url() || '').toLowerCase().includes('card-fields') || (f.name() || '').toLowerCase().includes('paypal') || (f.name() || '').toLowerCase().includes('card-fields'))) : [];
    const contextosPrioritarios = [...framesPayPal, targetContext, ...(targetContext.frames ? targetContext.frames() : [])];

    const llenarCampo = async (selectores, valor, nombreCampo) => {
        for (const ctx of contextosPrioritarios) {
            for (const sel of selectores) {
                try {
                    const el = ctx.locator(sel).first();
                    if (await el.isVisible({ timeout: 100 }).catch(() => false)) {
                        await el.scrollIntoViewIfNeeded().catch(() => {});
                        await el.click({ force: true });
                        await el.fill(valor, { force: true });
                        await el.dispatchEvent('input', { bubbles: true }).catch(() => {});
                        await el.dispatchEvent('change', { bubbles: true }).catch(() => {});
                        await el.dispatchEvent('blur', { bubbles: true }).catch(() => {});
                        return true;
                    }
                } catch(e) {}
            }
        }
        return false;
    };

    // 1. Tarjeta (16 dígitos)
    await llenarCampo(['input#credit-card-number', 'input[name="credit-card-number"]', 'input[name="cardNumber"]', 'input[autocomplete="cc-number"]', 'input[placeholder*="tarjeta" i]', '#cardNumber', '#credit-card-number'], cc, 'Tarjeta');

    // 2. Fecha de Vencimiento (MM/AA)
    const expFormato = `${mes}/${anio.slice(-2)}`;
    await llenarCampo(['input#expiration-date', 'input[name="expiration-date"]', 'input[name="expiry"]', 'input[name="expiration"]', 'input[autocomplete="cc-exp"]', 'input[placeholder*="vencimiento" i]', 'input[placeholder*="MM" i]', '#expiry'], expFormato, 'Vencimiento');

    // 3. Código de Seguridad CVV
    await llenarCampo(['input#cvv', 'input#csc', 'input[name="cvv"]', 'input[name="csc"]', 'input[name="cardCvv"]', 'input[autocomplete="cc-csc"]', 'input[placeholder*="CSC" i]', 'input[placeholder*="CVV" i]'], cvv, 'CVV');

    // 4. Nombre
    const nomTexto = typeof nombre === 'object' ? nombre.nom : (nombre ? nombre.split(' ')[0] : 'Carlos');
    await llenarCampo(['input#given-name', 'input#firstName', 'input[name="given-name"]', 'input[name="firstName"]', 'div:has(> label:has-text("Nombre")) input', 'label:has-text("Nombre") ~ input'], nomTexto, 'Nombre');

    // 5. Apellidos
    const apeTexto = typeof nombre === 'object' ? nombre.ape : (nombre ? nombre.split(' ').slice(1).join(' ') : 'Garcia Lopez');
    await llenarCampo(['input#family-name', 'input#lastName', 'input[name="family-name"]', 'input[name="lastName"]', 'div:has(> label:has-text("Apellidos")) input', 'div:has(> label:has-text("Apellido")) input', 'label:has-text("Apellidos") ~ input'], apeTexto, 'Apellidos');

    // 6. Dirección de facturación
    await llenarCampo(['input#address-line1', 'input#line1', 'input[name="address-line1"]', 'input[name="line1"]', 'input[name="billingAddress.line1"]', 'input[placeholder*="Dirección" i]', 'input[placeholder*="Calle" i]'], dirInfo.calle, 'Dirección');

    // 7. Código Postal (SEPOMEX)
    const cpGenerado = cp_auto || dirInfo.cp;
    await llenarCampo(['input#postal-code', 'input#postalCode', 'input#zip', 'input[name="postal-code"]', 'input[name="postalCode"]', 'input[name="zip"]', 'div:has(> label:has-text("Código postal")) input', 'label:has-text("Código postal") ~ input'], cpGenerado, 'CP');

    // 8. Ciudad y Estado
    await llenarCampo(['input#city', 'input[name="admin-area2"]', 'input[name="city"]', 'input[placeholder*="Ciudad" i]'], dirInfo.ciudad, 'Ciudad');
    await llenarCampo(['input#state', 'input[name="admin-area1"]', 'input[name="state"]', 'input[placeholder*="Estado" i]'], dirInfo.estado, 'Estado');

    // 9. Celular
    const telGenerado = tel_auto || generarTelefonoUnico();
    await llenarCampo(['input#tel', 'input#phone', 'input[name="tel"]', 'input[name="phone"]', 'input[placeholder*="Celular" i]'], telGenerado, 'Celular');

    // 10. Correo
    const correoGenerado = correo_auto || generarCorreoUnico(typeof nombre === 'object' ? nombre : { nom: nomTexto, ape: apeTexto });
    await llenarCampo(['input#email', 'input[name="email"]', 'input[type="email"]', 'input[placeholder*="Correo" i]'], correoGenerado, 'Correo');

    // 11. Casilla Privacidad PayPal
    const selectoresConsent = [
        'input[name="consent-checkbox"]',
        'input[type="checkbox"][name*="consent" i]',
        'input[type="checkbox"]#consent-checkbox',
        'input.css-1xl0111-StyledInput-inputStyles',
        'label:has-text("Confirmo que soy mayor de edad")',
        'input[type="checkbox"]'
    ];

    let consentChecked = false;
    for (const ctx of contextosPrioritarios) {
        for (const sel of selectoresConsent) {
            try {
                const cb = ctx.locator(sel).first();
                if (await cb.isVisible({ timeout: 100 }).catch(() => false)) {
                    await cb.scrollIntoViewIfNeeded().catch(() => {});
                    await cb.check({ force: true }).catch(() => cb.click({ force: true }));
                    consentChecked = true;
                    break;
                }
            } catch(e) {}
        }
        if (consentChecked) break;
    }

    await pag.waitForTimeout(500);

    // 12. Botón Pagar en la pasarela de tarjeta (PayPal)
    const selectoresBotonPagar = [
        'button#submit-button',
        'button[id="submit-button"]',
        'button.css-aezqgw-button-Button',
        'button[class*="button-Button"]',
        'button[aria-live="polite"]',
        '#submit-button'
    ];

    let clickPagar = false;
    const inicioEsperaPago = Date.now();
    const TIMEOUT_BTN_PAGO = 20000;

    while (Date.now() - inicioEsperaPago < TIMEOUT_BTN_PAGO) {
        for (const ctx of contextosPrioritarios) {
            for (const sel of selectoresBotonPagar) {
                try {
                    const btn = ctx.locator(sel).first();
                    if (await btn.isVisible({ timeout: 150 }).catch(() => false)) {
                        await btn.scrollIntoViewIfNeeded().catch(() => {});
                        
                        // Intento 1: Click nativo Playwright
                        await btn.click({ force: true, delay: 50 }).catch(() => {});
                        
                        // Intento 2: Eventos completos de Mouse en DOM
                        await btn.evaluate(el => {
                            el.focus();
                            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                            if (typeof el.click === 'function') el.click();
                        }).catch(() => {});

                        clickPagar = true;
                        console.log(`[Bait Usuario ${id}] 💸 Clic en botón Pagar de pasarela (${sel})`);
                        break;
                    }
                } catch(e) {}
            }
            if (clickPagar) break;
        }
        if (clickPagar) break;
        await pag.waitForTimeout(250);
    }

    // 13. Verificación de que PayPal recibió el clic y comenzó a procesar
    if (clickPagar) {
        for (let check = 1; check <= 4; check++) {
            await pag.waitForTimeout(1000);
            let sigueSinProcesar = false;
            for (const ctx of framesPayPal) {
                try {
                    const btn = ctx.locator('button#submit-button, button.css-aezqgw-button-Button').first();
                    if (await btn.isVisible({ timeout: 100 }).catch(() => false)) {
                        const ariaDis = await btn.getAttribute('aria-disabled').catch(() => '');
                        if (ariaDis === 'false') {
                            sigueSinProcesar = true;
                            console.log(`[Bait Usuario ${id}] 🔄 Reintentando clic directo en Pagar (${check})...`);
                            await btn.scrollIntoViewIfNeeded().catch(() => {});
                            await btn.click({ force: true }).catch(() => {});
                            await btn.evaluate(el => el.click()).catch(() => {});
                        }
                    }
                } catch(e) {}
            }
            if (!sigueSinProcesar) {
                console.log(`[Bait Usuario ${id}] ✅ Botón Pagar procesado por PayPal`);
                break;
            }
        }
    }

    console.log(`[Bait Usuario ${id}] ⏳ Esperando procesamiento de PayPal tras clic en Pagar...`);
    await pag.waitForTimeout(3000);

    return { exito: true, consentChecked, clickPagar, targetContext };
}

async function paso3ConfirmarTerminosYPagarAhoraBait(pag, id, monto = 300) {
    const inicioEsperaCheckout = Date.now();
    const TIMEOUT_CHECKOUT_MS = 15000;
    let botonPagarAhoraClickeado = false;

    // 1. Intentar marcar checkbox de términos y dar clic en "Pagar ahora" si BAIT lo muestra en la página principal
    while (Date.now() - inicioEsperaCheckout < TIMEOUT_CHECKOUT_MS) {
        const selectoresCheckboxBait = [
            'label:has-text("He leído, entiendo y consiento") input[type="checkbox"]',
            'div:has-text("Aviso de Privacidad") input[type="checkbox"]',
            'input[type="checkbox"]'
        ];

        for (const sel of selectoresCheckboxBait) {
            try {
                const cbs = pag.locator(sel);
                const count = await cbs.count().catch(() => 0);
                if (count > 0) {
                    const cb = cbs.first();
                    if (await cb.isVisible({ timeout: 50 }).catch(() => false)) {
                        await cb.scrollIntoViewIfNeeded().catch(() => {});
                        await cb.check({ force: true }).catch(() => cb.click({ force: true }));
                        break;
                    }
                }
            } catch(e) {}
        }

        const selectoresPagarAhora = [
            'button:has-text("Pagar ahora")',
            'button:has-text("PAGAR AHORA")',
            'button:has-text("Pagar Ahora")',
            'button.ph-bait-ex-85__submit:has-text("Pagar")',
            'button:has-text("Pagar")'
        ];

        for (const sel of selectoresPagarAhora) {
            try {
                const btn = pag.locator(sel).first();
                if (await btn.isVisible({ timeout: 80 }).catch(() => false)) {
                    await btn.scrollIntoViewIfNeeded().catch(() => {});
                    await btn.click({ force: true });
                    botonPagarAhoraClickeado = true;
                    console.log(`[Bait Usuario ${id}] 🚀 Clic en botón final PAGAR AHORA`);
                    break;
                }
            } catch(e) {}
        }

        if (botonPagarAhoraClickeado) break;

        // Comprobar si ya apareció un resultado en pantalla
        const textoBody = await pag.evaluate(() => (document.body ? document.body.innerText : '') || '').catch(() => '');
        if (/(éxito)|(exitosa)|(recarga\s*exitosa)|(pago\s*exitoso)|(folio)|(fondos\s*insuficientes)|(tarjeta\s*rechazada)|(declinada)/i.test(textoBody)) {
            break;
        }

        await pag.waitForTimeout(300);
    }

    // 2. Polling activo de respuesta en la página y frames
    let textoFinalPagina = "";
    let clasificacionFinal = null;
    let ultimoEstadoLog = null;
    let estadoFinalCandidato = null;
    let repeticionesEstadoFinal = 0;
    const inicioEsperaRespuesta = Date.now();
    const TIEMPO_ESPERA_RESPUESTA_MS = 65000;

    while (Date.now() - inicioEsperaRespuesta < TIEMPO_ESPERA_RESPUESTA_MS) {
        const contexto = pag.context();
        const paginas = contexto && contexto.pages ? contexto.pages() : [pag];
        const popup = popupsActivosBait.get(id);
        const paginasARevisar = (popup && !popup.isClosed() && !paginas.includes(popup))
            ? [...paginas, popup]
            : paginas;

        let fragmentosTotales = [];

        for (const p of paginasARevisar) {
            const frames = p.frames ? p.frames() : [p];
            for (const f of frames) {
                try {
                    const txtFrame = await f.evaluate(() => {
                        const esVisible = el => {
                            if (!el) return false;
                            const s = window.getComputedStyle(el);
                            return s && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
                        };
                        const selectores = [
                            'dialog[open]',
                            '.modal.show',
                            '.modal-content',
                            '.alert',
                            '.error-container',
                            '.error',
                            '[class*="voucher" i]',
                            '[class*="receipt" i]',
                            '[class*="success" i]',
                            '[class*="result" i]',
                            '[class*="summary" i]',
                            'app-root main',
                            'body'
                        ];
                        let frags = [];
                        for (const sel of selectores) {
                            document.querySelectorAll(sel).forEach(el => {
                                if (esVisible(el)) {
                                    const t = (el.innerText || '').trim();
                                    if (t.length > 0 && !frags.includes(t)) frags.push(t);
                                }
                            });
                        }
                        return frags.join(' \n ');
                    }).catch(() => '');

                    if (txtFrame && txtFrame.length > 0) {
                        fragmentosTotales.push(txtFrame);
                    }
                } catch(e) {}
            }
        }

        textoFinalPagina = fragmentosTotales.join(' \n ');
        clasificacionFinal = clasificarResultadoBait(textoFinalPagina, id);

        if (clasificacionFinal.estado !== ultimoEstadoLog) {
            ultimoEstadoLog = clasificacionFinal.estado;
            if (clasificacionFinal.estado !== 'DESCONOCIDO') {
                console.log(`[Bait Usuario ${id}] Estado detectado: ${clasificacionFinal.estado}`);
            }
            if (clasificacionFinal.estado === 'PROCESANDO') {
                console.log(`⏳ [Bait Usuario ${id}] Pago/recarga en proceso — esperando resultado definitivo...`);
            }
        }

        if (['EXITO', 'RECHAZO_BANCARIO', 'ERROR_PASARELA'].includes(clasificacionFinal.estado)) {
            if (estadoFinalCandidato === clasificacionFinal.estado) {
                repeticionesEstadoFinal += 1;
            } else {
                estadoFinalCandidato = clasificacionFinal.estado;
                repeticionesEstadoFinal = 1;
            }

            if (repeticionesEstadoFinal >= 3) {
                console.log(`✅ [Bait Usuario ${id}] Estado final estable: ${clasificacionFinal.estado}. Esperando render visual final...`);
                await pag.waitForTimeout(1500);
                break;
            }
        } else {
            estadoFinalCandidato = null;
            repeticionesEstadoFinal = 0;
        }

        await pag.waitForTimeout(700);
    }

    if (!clasificacionFinal || clasificacionFinal.estado === 'DESCONOCIDO') {
        clasificacionFinal = clasificarResultadoBait(textoFinalPagina, id);
    }

    if (ultimoEstadoLog === 'PROCESANDO' && (clasificacionFinal.estado === 'DESCONOCIDO' || clasificacionFinal.estado === 'PROCESANDO')) {
        clasificacionFinal = {
            estado: 'PROCESANDO',
            subtipo: 'TIMEOUT_PROCESANDO',
            titulo: '⏳ RECARGA EN PROCESO — SIN CONFIRMACIÓN FINAL',
            icono: '⏳',
            explicacion: 'La recarga fue enviada pero el portal continúa procesando sin emitir confirmación definitiva.'
        };
    }

    let capturaFinal = null;
    if (['EXITO', 'RECHAZO_BANCARIO', 'ERROR_PASARELA'].includes(clasificacionFinal.estado) && pag && !pag.isClosed()) {
        // Pequeño colchón adicional para que el tache/círculo/comprobante termine de pintarse.
        await pag.waitForTimeout(1200);
        capturaFinal = await tomarCapturaEnfocada(pag).catch(() => null);
    }

    return {
        exito: clasificacionFinal.estado === 'EXITO',
        pagoConfirmado: clasificacionFinal.estado === 'EXITO',
        botonPagarAhoraClickeado,
        clasificacion: clasificacionFinal,
        textoLeido: extraerFragmentoClave(textoFinalPagina),
        captura: capturaFinal
    };
}

// 8. GESTOR DE INTENTO INDIVIDUAL (CONTEXTO LIMPIO POR INTENTO)
async function ejecutarIntentoBait(ctx, id, datos, intento, nav) {
    const { numero, monto: montoIn } = datos;
    const monto = montoIn || 300;

    const personaAuto = generarNombreCompleto();
    const direccionValida = generarDireccionValida();
    const cpAuto = direccionValida.cp;
    const correoDinamico = generarCorreoUnico(personaAuto);
    const telDinamico = generarTelefonoUnico();

    const datosCompletos = {
        ...datos,
        nombre: personaAuto,
        direccion_valida: direccionValida,
        cp_auto: cpAuto,
        correo_auto: correoDinamico,
        tel_auto: telDinamico
    };

    console.log(`🔄 [Bait Usuario ${id}] Intento ${intento}/${MAX_RETRIES_BAIT}`);
    const { contexto, pag } = await crearContextoBait(nav, id);
    console.log(`🧹 [Bait Usuario ${id}] Contexto limpio creado`);

    let pasarelaDetectada = false;

    try {
        await abrirPaqueteBait(pag, id, numero, correoDinamico, monto);

        // Esperar explícitamente a que termine la pantalla/modal intermedio antes de buscar la pasarela
        const resIntermedia = await esperarFinPantallaIntermediaBait(pag, id);

        if (resIntermedia && resIntermedia.estado === 'ERROR_BAIT_TEMPORAL') {
            console.log(`⚠️ [Bait Usuario ${id}] ERROR_BAIT_TEMPORAL — portal BAIT respondió con error visible. Omitiendo detección de pasarela.`);
            let capturaDiag = null;
            if (pag && !pag.isClosed()) {
                try { capturaDiag = await tomarCapturaEnfocada(pag); } catch(e) {}
            }
            await cerrarContextoBait(contexto, id);
            return {
                exito: false,
                pagoConfirmado: false,
                pasarelaDetectada: false,
                pag: null,
                contexto: null,
                captura: capturaDiag,
                datos: datosCompletos,
                resultado: {
                    exito: false,
                    pagoConfirmado: false,
                    pasarela: 'DESCONOCIDA',
                    clasificacion: {
                        estado: 'ERROR_BAIT_TEMPORAL',
                        subtipo: 'PORTAL_BAIT_NO_DISPONIBLE',
                        titulo: '⚠️ ERROR TEMPORAL EN PORTAL BAIT',
                        icono: '⚠️',
                        explicacion: 'El portal BAIT respondió con mensaje de error ("Ocurrió un error, inténtalo de nuevo más tarde").'
                    },
                    textoLeido: 'ERROR_BAIT_TEMPORAL'
                }
            };
        }

        if (resIntermedia && resIntermedia.estado === 'MODAL_REGISTRO_ATASCADO') {
            let capturaDiag = null;
            if (pag && !pag.isClosed()) {
                try { capturaDiag = await tomarCapturaEnfocada(pag); } catch(e) {}
            }
            await cerrarContextoBait(contexto, id);
            return {
                exito: false,
                pagoConfirmado: false,
                pasarelaDetectada: false,
                pag: null,
                contexto: null,
                captura: capturaDiag,
                datos: datosCompletos,
                resultado: {
                    exito: false,
                    pagoConfirmado: false,
                    pasarela: 'DESCONOCIDA',
                    clasificacion: {
                        estado: 'MODAL_REGISTRO_ATASCADO',
                        subtipo: 'BAIT_TRANSICION_NO_TERMINO',
                        titulo: '⚠️ MODAL REGISTRA TU LÍNEA ATASCADO',
                        icono: '⚠️',
                        explicacion: 'El modal REGISTRA TU LÍNEA permaneció en pantalla durante más de 15 segundos sin permitir la carga de la pasarela.'
                    },
                    textoLeido: 'MODAL_REGISTRO_ATASCADO'
                }
            };
        }

        const t0 = Date.now();
        const resultadoPasarela = await detectarPasarelaBait(pag, id, intento);
        const transcurrido = Date.now() - t0;

        if (resultadoPasarela.pasarela === 'PAYPAL' && resultadoPasarela.confirmada === true) {
            console.log(`✅ [Bait Usuario ${id}] PAYPAL CONFIRMADO (${transcurrido} ms)`);
            pasarelaDetectada = true;
            const resultadoFinalBait = await paso3DiagnosticoYElementosPayPalBait(pag, id, datosCompletos, monto);
            return {
                exito: resultadoFinalBait.exito,
                pagoConfirmado: Boolean(resultadoFinalBait && resultadoFinalBait.pagoConfirmado),
                pag,
                contexto,
                datos: datosCompletos,
                captura: resultadoFinalBait.captura || null,
                resultado: resultadoFinalBait,
                pasarelaDetectada: true
            };
        }

        let capturaDiag = null;
        if (pag && !pag.isClosed()) {
            try {
                capturaDiag = await tomarCapturaEnfocada(pag);
            } catch {}
        }

        if (resultadoPasarela.pasarela === 'CONEKTA') {
            console.log(`⚠️ [Bait Usuario ${id}] CONEKTA CONFIRMADO — PASARELA NO ADMITIDA — PAGO NO INICIADO (${transcurrido} ms)`);
            console.log(`🔄 [Bait Usuario ${id}] Pasarela Conekta rechazada. Cerrando contexto y volviendo a intentar detectar pasarela normalmente (Intento ${intento}/${MAX_RETRIES_BAIT})...`);
            await cerrarContextoBait(contexto, id);
            return {
                exito: false,
                pagoConfirmado: false,
                pasarelaDetectada: false,
                pag: null,
                contexto: null,
                captura: capturaDiag,
                datos: datosCompletos,
                resultado: {
                    exito: false,
                    pagoConfirmado: false,
                    pasarela: 'CONEKTA',
                    clasificacion: {
                        estado: 'PASARELA_NO_ADMITIDA',
                        subtipo: 'CONEKTA_NO_ADMITIDA',
                        titulo: '⚠️ BAIT ENTREGÓ CONEKTA',
                        icono: '⚠️',
                        explicacion: `Este flujo requiere PayPal. Se realizaron ${intento} intentos sin obtener PayPal.`
                    },
                    textoLeido: 'CONEKTA CONFIRMADO'
                }
            };
        } else {
            console.log(`⏱️ [Bait Usuario ${id}] TIMEOUT — PASARELA NO DETERMINADA (${transcurrido} ms)`);
            console.log(`🔄 [Bait Usuario ${id}] Cerrando contexto y volviendo a intentar detectar pasarela normalmente (Intento ${intento}/${MAX_RETRIES_BAIT})...`);
            await cerrarContextoBait(contexto, id);
            return {
                exito: false,
                pagoConfirmado: false,
                pasarelaDetectada: false,
                pag: null,
                contexto: null,
                captura: capturaDiag,
                datos: datosCompletos,
                resultado: {
                    exito: false,
                    pagoConfirmado: false,
                    pasarela: 'DESCONOCIDA',
                    clasificacion: {
                        estado: 'PASARELA_NO_DETERMINADA',
                        subtipo: 'TIMEOUT_DETECCION',
                        titulo: '⏱️ PASARELA NO DETERMINADA',
                        icono: '⏱️',
                        explicacion: `No se obtuvo respuesta concluyente de la pasarela dentro del tiempo límite tras ${intento} intentos.`
                    },
                    textoLeido: 'PASARELA_NO_DETERMINADA'
                }
            };
        }

    } catch (err) {
        let capturaError = null;
        if (pag && !pag.isClosed()) {
            try { capturaError = await tomarCapturaEnfocada(pag); } catch(e) {}
        }
        await cerrarContextoBait(contexto, id);

        const codigoError = err.codigo || err.message || '';

        if (codigoError.includes('NUMERO_INVALIDO')) {
            console.log(`⚠️ [Bait Usuario ${id}] NUMERO_INVALIDO detectado`);
            return {
                exito: false,
                pagoConfirmado: false,
                pag: null,
                contexto: null,
                captura: null,
                datos: datosCompletos,
                pasarelaDetectada: true,
                resultado: {
                    exito: false,
                    pagoConfirmado: false,
                    pasarela: 'DESCONOCIDA',
                    clasificacion: {
                        estado: 'NUMERO_INVALIDO',
                        subtipo: 'NUMERO_INVALIDO',
                        titulo: '❌ NÚMERO INVÁLIDO',
                        icono: '❌',
                        explicacion: 'El número ingresado no es válido o no fue reconocido por BAIT.'
                    },
                    textoLeido: 'NUMERO_INVALIDO'
                }
            };
        }

        if (codigoError.includes('ERROR_BAIT_TEMPORAL')) {
            console.log(`⚠️ [Bait Usuario ${id}] ERROR_BAIT_TEMPORAL — portal BAIT respondió con error visible (Intento ${intento}/${MAX_RETRIES_BAIT})`);
            return {
                exito: false,
                pagoConfirmado: false,
                pag: null,
                contexto: null,
                captura: capturaError,
                datos: datosCompletos,
                pasarelaDetectada: false,
                resultado: {
                    exito: false,
                    pagoConfirmado: false,
                    pasarela: 'DESCONOCIDA',
                    clasificacion: {
                        estado: 'ERROR_BAIT_TEMPORAL',
                        subtipo: 'PORTAL_BAIT_NO_DISPONIBLE',
                        titulo: '⚠️ ERROR TEMPORAL EN PORTAL BAIT',
                        icono: '⚠️',
                        explicacion: 'El portal BAIT mostró un error temporal de servicio ("Ocurrió un error, inténtalo de nuevo más tarde").'
                    },
                    textoLeido: 'ERROR_BAIT_TEMPORAL'
                }
            };
        }

        if (codigoError.includes('BAIT_HOME_NO_CARGO')) {
            console.log(`⚠️ [Bait Usuario ${id}] BAIT_HOME_NO_CARGO — la página de inicio de BAIT no cargó (Intento ${intento}/${MAX_RETRIES_BAIT})`);
            return {
                exito: false,
                pagoConfirmado: false,
                pag: null,
                contexto: null,
                captura: capturaError,
                datos: datosCompletos,
                pasarelaDetectada: false,
                resultado: {
                    exito: false,
                    pagoConfirmado: false,
                    pasarela: 'DESCONOCIDA',
                    clasificacion: {
                        estado: 'BAIT_HOME_NO_CARGO',
                        subtipo: 'HOME_TIMEOUT',
                        titulo: '⏱️ LA PÁGINA DE BAIT NO CARGÓ',
                        icono: '⏱️',
                        explicacion: 'No se pudo cargar la página principal de recargas de BAIT.'
                    },
                    textoLeido: 'BAIT_HOME_NO_CARGO'
                }
            };
        }

        if (codigoError.includes('PAQUETE_BAIT_NO_VISIBLE')) {
            console.log(`⚠️ [Bait Usuario ${id}] PAQUETE_BAIT_NO_VISIBLE — el paquete $${monto} no apareció en pantalla (Intento ${intento}/${MAX_RETRIES_BAIT})`);
            return {
                exito: false,
                pagoConfirmado: false,
                pag: null,
                contexto: null,
                captura: capturaError,
                datos: datosCompletos,
                pasarelaDetectada: false,
                resultado: {
                    exito: false,
                    pagoConfirmado: false,
                    pasarela: 'DESCONOCIDA',
                    clasificacion: {
                        estado: 'PAQUETE_BAIT_NO_VISIBLE',
                        subtipo: 'PAQUETE_NO_ENCONTRADO',
                        titulo: '⚠️ PAQUETE NO ENCONTRADO EN BAIT',
                        icono: '⚠️',
                        explicacion: `No se encontró el botón del paquete de $${monto} MXN en la página.`
                    },
                    textoLeido: 'PAQUETE_BAIT_NO_VISIBLE'
                }
            };
        }

        if (codigoError.includes('MODAL_BAIT_NO_ABRIO')) {
            console.log(`⚠️ [Bait Usuario ${id}] MODAL_BAIT_NO_ABRIO — el diálogo de datos de línea no abrió (Intento ${intento}/${MAX_RETRIES_BAIT})`);
            return {
                exito: false,
                pagoConfirmado: false,
                pag: null,
                contexto: null,
                captura: capturaError,
                datos: datosCompletos,
                pasarelaDetectada: false,
                resultado: {
                    exito: false,
                    pagoConfirmado: false,
                    pasarela: 'DESCONOCIDA',
                    clasificacion: {
                        estado: 'MODAL_BAIT_NO_ABRIO',
                        subtipo: 'MODAL_NO_RESPONDE',
                        titulo: '⚠️ DIÁLOGO DE BAIT NO RESPONDIÓ',
                        icono: '⚠️',
                        explicacion: 'No se abrió el formulario de ingreso de línea tras hacer clic en el paquete.'
                    },
                    textoLeido: 'MODAL_BAIT_NO_ABRIO'
                }
            };
        }

        if (codigoError.includes('BOTON_AVANCE_NO_HABILITADO')) {
            console.log(`⚠️ [Bait Usuario ${id}] BOTON_AVANCE_NO_HABILITADO — el botón Continuar al pago no se habilitó (Intento ${intento}/${MAX_RETRIES_BAIT})`);
            return {
                exito: false,
                pagoConfirmado: false,
                pag: null,
                contexto: null,
                captura: capturaError,
                datos: datosCompletos,
                pasarelaDetectada: false,
                resultado: {
                    exito: false,
                    pagoConfirmado: false,
                    pasarela: 'DESCONOCIDA',
                    clasificacion: {
                        estado: 'BOTON_AVANCE_NO_HABILITADO',
                        subtipo: 'AVANCE_DESHABILITADO',
                        titulo: '⚠️ BOTÓN DE AVANCE NO HABILITADO',
                        icono: '⚠️',
                        explicacion: 'El botón para continuar al pago permaneció deshabilitado tras ingresar los datos.'
                    },
                    textoLeido: 'BOTON_AVANCE_NO_HABILITADO'
                }
            };
        }

        if (pasarelaDetectada && pag && !pag.isClosed()) {
            console.log(`[Bait Usuario ${id}] ⚠️ Error posterior a detectar PayPal: ${err.message}. Retornando ERROR_POST_PAYPAL.`);
            return {
                exito: false,
                pagoConfirmado: false,
                pag,
                contexto,
                datos: datosCompletos,
                pasarelaDetectada: true,
                resultado: {
                    exito: false,
                    pagoConfirmado: false,
                    clasificacion: {
                        estado: 'ERROR_POST_PAYPAL',
                        subtipo: 'EXCEPCION_INTERNA',
                        titulo: '⚠️ ERROR POSTERIOR A PAYPAL',
                        icono: '⚠️',
                        explicacion: 'Se detectó PayPal pero ocurrió una falla al procesar la información.'
                    },
                    textoLeido: err.message || 'Error técnico en pasarela'
                },
                captura: capturaError
            };
        }

        console.log(`🧹 [Bait Usuario ${id}] Contexto cerrado tras excepción: ${err.message || err}`);
        return { exito: false, pagoConfirmado: false, pag: null, error: err, captura: capturaError, pasarelaDetectada: false };
    }
}

// 9. FLUJO PRINCIPAL BAIT (UN SOLO CHROMIUM — CONTROL DE CICLO DE VIDA)
async function flujoBait(ctx, id, datos) {
    const { numero, monto: montoIn } = datos;
    const monto = montoIn || 300;
    const inicioBait = Date.now();

    const miId = (ejecucionesUsuario.get(id) || 0) + 1;
    ejecucionesUsuario.set(id, miId);

    await enviarLimpio(ctx,
        `🦁 <b>BOT LEÓN — PROCESANDO BAIT</b> 🤖\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 <b>Línea:</b> <code>${numero}</code>\n` +
        `💲 <b>Monto:</b> $${monto} MXN\n\n` +
        `⏳ ▫️ Conectando con la pasarela de pago...\n` +
        `▫️ No cierres esta ventana.`
    );

    let resultadoFinal = null;
    let nav = null;

    try {
        nav = await crearNavegadorBait(id);

        for (let intento = 1; intento <= MAX_RETRIES_BAIT; intento++) {
            if (miId !== ejecucionesUsuario.get(id)) return;

            resultadoFinal = await ejecutarIntentoBait(ctx, id, datos, intento, nav);
            if (resultadoFinal && resultadoFinal.pasarelaDetectada) {
                break;
            }
        }

        if (miId !== ejecucionesUsuario.get(id)) return;

        if (resultadoFinal) {
            const pag = resultadoFinal.pag;
            const info = resultadoFinal.resultado || {};
            const clasif = info.clasificacion || {
                estado: 'DESCONOCIDO',
                subtipo: 'SIN_CONFIRMACION',
                titulo: '⚠️ TRANSACCIÓN NO CONFIRMADA',
                icono: '⚠️',
                explicacion: 'No se obtuvo confirmación definitiva de la pasarela.'
            };
            const fragmento = info.textoLeido || 'Sin información de respuesta';

            if (clasif.estado === 'NUMERO_INVALIDO') {
                console.log(`[Bait Usuario ${id}] ⚠️ NUMERO_INVALIDO detectado`);
                console.log(`[Bait Usuario ${id}] 🧹 Intento anterior cerrado`);
                console.log(`[Bait Usuario ${id}] 🔄 Esperando nuevo número`);

                const s = sesiones.get(id) || datos;
                s.paso = 'numero';
                s.numero = null;
                sesiones.set(id, s);

                await limpiarMensajesTemporales(ctx, id);
                await ctx.replyWithHTML(
                    `❌ <b>El número ingresado no es válido o no fue reconocido.</b>\n\n` +
                    `📱 <b>Ingresa nuevamente el número de 10 dígitos:</b>`
                ).catch(() => {});
                return;
            }
            
          let captura = resultadoFinal.captura || null;

            await limpiarMensajesTemporales(ctx, id);

            let captionFinal = '';

            if (clasif.estado === 'CHECKOUT_LISTO' || clasif.estado === 'PAYPAL_CARD_CHECKOUT_CONFIRMADO') {
                captionFinal =
                    `🦁 <b>BOT LEÓN — DIAGNÓSTICO BAIT / PAYPAL</b> 🔍\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📱 <b>Línea:</b> <code>${numero}</code>\n` +
                    `💲 <b>Monto:</b> $${monto} MXN\n\n` +
                    `✅ ▫️ <b>PAYPAL DETECTADO</b>\n` +
                    `✅ ▫️ <b>Checkout de tarjeta abierto correctamente</b>\n` +
                    `🛑 ▫️ <b>Prueba detenida antes del pago</b>\n` +
                    `📌 ▫️ <b>Estado:</b> <code>CHECKOUT_LISTO</code>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `👉 <b>Toca /start para realizar otra operación.</b>`;

              await ctx.replyWithHTML(captionFinal);

            } else if (['PASARELA_NO_ADMITIDA', 'CONEKTA_DETECTADO', 'PASARELA_NO_DETERMINADA', 'PASARELA_TIMEOUT', 'ERROR_BAIT_TEMPORAL', 'BAIT_HOME_NO_CARGO', 'PAQUETE_BAIT_NO_VISIBLE', 'MODAL_BAIT_NO_ABRIO', 'BOTON_AVANCE_NO_HABILITADO'].includes(clasif.estado)) {
                const s = sesiones.get(id) || {};
                const ult4 = s.ult4 || (s.tarjeta ? s.tarjeta.slice(-4) : '****');

                captionFinal =
                    `🦁 <b>BAIT — 5 INTENTOS COMPLETADOS</b> 🔄\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📱 <b>Línea:</b> <code>${numero}</code>\n` +
                    `💲 <b>Monto:</b> $${monto} MXN\n` +
                    `💳 <b>Tarjeta cargada:</b> <code>•••• ${ult4}</code>\n\n` +
                    `⚠️ ▫️ En los 5 intentos BAIT no entregó la pasarela PayPal.\n` +
                    `🔒 ▫️ Por seguridad, tus datos bancarios <b>SOLO</b> se procesan en PayPal.\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `👉 <b>¿Deseas realizar otro ciclo de 5 intentos con el mismo número y tarjeta?</b>`;

                const tecladoReintento = Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 REINTENTAR 5 VECES MÁS', 'btn_reintentar_bait')],
                    [Markup.button.callback('🦁 IR AL MENÚ PRINCIPAL', 'btn_reiniciar')]
                ]);

    await ctx.reply(captionFinal, {
    parse_mode: 'HTML',
    ...tecladoReintento
});

     } else if (clasif.estado === 'MODAL_REGISTRO_ATASCADO') {
    captionFinal =
        `⚠️ <b>MODAL REGISTRA TU LÍNEA ATASCADO</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 <b>Línea:</b> <code>${numero}</code>\n` +
        `💲 <b>Monto:</b> $${monto} MXN\n\n` +
        `⚠️ ▫️ El modal de registro de línea no finalizó tras 15 segundos.\n` +
        `ℹ️ ▫️ No se realizó ningún cobro ni operación.\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👉 <b>Toca /start para intentar de nuevo.</b>`;

    await ctx.replyWithHTML(captionFinal);

} else if (clasif.estado === 'EXITO' && info.pagoConfirmado === true) {

    if (!captura && pag && !pag.isClosed()) {
        try {
            captura = await tomarCapturaEnfocada(pag);
        } catch(e) {}
    }

    const totalSegundos = Math.max(
        0,
        Math.round((Date.now() - inicioBait) / 1000)
    );

    const minutos = Math.floor(totalSegundos / 60);
    const segundos = totalSegundos % 60;

    const tiempoTexto =
        minutos > 0
            ? `${minutos} min ${segundos} s`
            : `${segundos} s`;

    captionFinal =
        `🦁 <b>BOT LEÓN — COMPROBANTE DE RECARGA EXITOSA</b> ✅\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 <b>Línea:</b> <code>${numero}</code>\n` +
        `💲 <b>Monto:</b> $${monto} MXN\n` +
        `✅ <b>Estado:</b> Recarga aprobada y aplicada\n` +
        `⏱️ <b>Tiempo total:</b> ${tiempoTexto}\n` +
        `📄 <b>Folio / Ticket:</b> "<i>${fragmento}</i>"\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👉 <b>Toca /start para realizar otra recarga.</b>`;

    if (captura) {
        await ctx.replyWithPhoto(
            { source: captura },
            {
                caption: captionFinal.slice(0, 1024),
                parse_mode: 'HTML'
            }
        );
    } else {
        await ctx.replyWithHTML(captionFinal);
    }

            } else if (clasif.estado === 'RECHAZO_BANCARIO') {
                const sPrev = sesiones.get(id) || {};
                const ult4 = sPrev.ult4 || (sPrev.tarjeta ? sPrev.tarjeta.slice(-4) : '****');
                sesiones.delete(id);

                captionFinal =
                    `❌ <b>RECARGA NO COMPLETADA: PAGO RECHAZADO</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📱 <b>Línea:</b> <code>${numero}</code>\n` +
                    `💲 <b>Monto:</b> $${monto} MXN\n` +
                    `💳 <b>Tarjeta:</b> <code>•••• ${ult4}</code>\n\n` +
                    `💡 <b>Motivo:</b> Tu forma de pago rechazó el cargo o no cuenta con fondos suficientes.\n` +
                    `⚠️ <i>Notificación: "Error al completar tu pago / Error interno"</i>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🛑 <b>El proceso ha finalizado. Toca abajo para empezar de 0 el proceso:</b>`;

                const tecladoReinicio = Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 REINTENTAR / EMPEZAR DE 0', 'btn_reiniciar')],
                    [Markup.button.callback('🦁 IR AL MENÚ PRINCIPAL', 'btn_reiniciar')]
                ]);

               if (captura) {
                   await ctx.replyWithPhoto({ source: captura }, {
                       caption: captionFinal.slice(0, 1024),
                       parse_mode: 'HTML',
                       ...tecladoReinicio
                   });
               } else {
                   await ctx.reply(captionFinal, {
                       parse_mode: 'HTML',
                       ...tecladoReinicio
                   });
               }

            } else if (clasif.estado === 'PROCESANDO') {
    captionFinal =
        `⏳ <b>RECARGA EN PROCESO — PENDIENTE DE CONFIRMACIÓN</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 <b>Línea:</b> <code>${numero}</code>\n` +
        `💲 <b>Monto:</b> $${monto} MXN\n` +
        `📄 <b>Estado:</b> "<i>${fragmento}</i>"\n\n` +
        `ℹ️ ▫️ La solicitud fue recibida y se encuentra en validación por el sistema.\n` +
        `👉 <b>Toca /start para realizar otra operación.</b>`;

    await ctx.replyWithHTML(captionFinal);

} else {
    captionFinal =
        (clasif.icono || '⚠️') + ` <b>` + clasif.titulo + `</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 <b>Línea:</b> <code>${numero}</code>\n` +
        `💲 <b>Monto:</b> $${monto} MXN\n` +
        `📄 <b>Mensaje detectado:</b> "<i>${fragmento}</i>"\n\n` +
        `🛑 <b>El flujo terminó sin una confirmación final confiable.</b>\n` +
        `ℹ️ No se puede asegurar desde esta pantalla si la recarga fue aplicada o rechazada.\n` +
        `🔎 <b>Verifica saldo, SMS o movimiento antes de volver a intentar.</b>`;

    if (captura) {
        await ctx.replyWithPhoto({ source: captura }, {
            caption: captionFinal.slice(0, 1024),
            parse_mode: 'HTML'
        });
    } else {
        await ctx.replyWithHTML(captionFinal);
    }
}

if (resultadoFinal.contexto) {
    await cerrarContextoBait(resultadoFinal.contexto, id);
}

} else {
    const capturaError = resultadoFinal?.captura;
    await limpiarMensajesTemporales(ctx, id);

    const msgError =
        `❌ <b>NO SE PUDO COMPLETAR EL FLUJO BAIT</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 <b>Número:</b> <code>${numero}</code>\n` +
        `💲 <b>Monto:</b> $${monto} MXN\n\n` +
        `📌 ▫️ Revisa tus datos e intenta de nuevo.\n` +
        `👉 <b>Toca /start para reiniciar.</b>`;

await ctx.replyWithHTML(msgError);
}

} finally {
    await cerrarNavegadorBait(id);
}
}
// ==============================================================================
// 🟣 TELCEL.COM / TIENDA TELCEL
// https://www.telcel.com/tienda/recarga-saldo
// ==============================================================================
const navegadoresTienda = new Map();
const URL_TELCEL_TIENDA = 'https://www.telcel.com/tienda/recarga-saldo';

function logTelcelTienda(id, msg) {
    console.log(`[Telcel.com Usuario ${id}] ${msg}`);
}

async function cerrarNavegadorTienda(id) {
    if (!id) {
        for (const [userId, nav] of navegadoresTienda) {
            try {
                for (const ctx of nav.contexts()) {
                    for (const p of ctx.pages()) {
                        await p.close().catch(() => {});
                    }
                    await ctx.close().catch(() => {});
                }
                await nav.close().catch(() => {});
            } catch (_) {}
        }
        navegadoresTienda.clear();
        return;
    }

    const nav = navegadoresTienda.get(id);
    navegadoresTienda.delete(id);

    if (!nav) return;

    try {
        for (const ctx of nav.contexts()) {
            for (const p of ctx.pages()) {
                await p.close().catch(() => {});
            }
            await ctx.close().catch(() => {});
        }
        await nav.close().catch(() => {});
    } catch (_) {}
}

async function crearNavegadorTienda(id) {
    await cerrarNavegadorTienda(id);

    const usarBrightData =
        !USE_LOCAL_CHROMIUM &&
        Boolean(
            BRIGHTDATA_BROWSER_WS &&
            (
                BRIGHTDATA_BROWSER_WS.startsWith('wss://') ||
                BRIGHTDATA_BROWSER_WS.startsWith('ws://')
            )
        );

    let browser;
    if (usarBrightData) {
        logTelcelTienda(id, '🌐 Conectando vía BrightData CDP...');
        browser = await chromium.connectOverCDP(BRIGHTDATA_BROWSER_WS, { timeout: 45000 });
    } else {
        browser = await chromium.launch({
            headless: ES_HEADLESS,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--no-first-run',
                '--lang=es-MX'
            ],
            timeout: 35000
        });
    }

    logTelcelTienda(id, '🟣 [Telcel.com] Navegador iniciado');

    const context = await browser.newContext({
        locale: 'es-MX',
        timezoneId: 'America/Mexico_City',
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();
    page.setDefaultTimeout(18000);
    page.setDefaultNavigationTimeout(45000);

    navegadoresTienda.set(id, browser);

    return { browser, context, page };
}

async function aceptarCookiesTienda(page) {
    const sels = [
        '#onetrust-accept-btn-handler',
        'button:has-text("Aceptar todas")',
        'button:has-text("Aceptar cookies")',
        'button:has-text("Aceptar")',
        'button[aria-label*="Aceptar" i]'
    ];

    for (const sel of sels) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 600 }).catch(() => false)) {
                await btn.click().catch(() => {});
                break;
            }
        } catch (_) {}
    }
}

async function buscarVisibleTienda(page, selectors, timeoutTotal = 12000) {
    const inicio = Date.now();

    while (Date.now() - inicio < timeoutTotal) {
        for (const sel of selectors) {
            try {
                const loc = page.locator(sel).first();
                if (await loc.isVisible({ timeout: 150 }).catch(() => false)) {
                    return { loc, sel };
                }
            } catch (_) {}
        }
        await page.waitForTimeout(200);
    }

    return null;
}

async function buscarCamposNumeroEnFrame(frame) {
    let campoNumero = null;
    let campoConfirmacion = null;

    const candidatosNumero = [
        frame.getByLabel('Número Telcel', { exact: true }).first(),
        frame.getByLabel('Numero Telcel', { exact: true }).first(),
        frame.locator('input[aria-label="Número Telcel"]').first(),
        frame.locator('input[aria-label="Numero Telcel"]').first(),
        frame.locator('input[name="mdn"]').first(),
        frame.locator('input#mdn').first()
    ];

    for (const loc of candidatosNumero) {
        if (await loc.isVisible({ timeout: 150 }).catch(() => false)) {
            campoNumero = loc;
            break;
        }
    }

    const candidatosConfirmacion = [
        frame.getByLabel(
            'Confirmar el número Telcel',
            { exact: true }
        ).first(),

        frame.getByLabel(
            'Confirmar el numero Telcel',
            { exact: true }
        ).first(),

        frame.locator('input[aria-label*="Confirmar" i]').first(),
        frame.locator('input[name="confirmMdn"]').first(),
        frame.locator('input#confirmMdn').first()
    ];

    for (const loc of candidatosConfirmacion) {
        if (await loc.isVisible({ timeout: 150 }).catch(() => false)) {
            campoConfirmacion = loc;
            break;
        }
    }

    if (!campoNumero || !campoConfirmacion) {
        const inputs = frame.locator(
            'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'
        );

        const encontrados = [];
        const total = await inputs.count().catch(() => 0);

        for (let i = 0; i < total; i++) {
            const input = inputs.nth(i);

            const visible = await input
                .isVisible({ timeout: 50 })
                .catch(() => false);

            const editable = await input
                .isEditable({ timeout: 50 })
                .catch(() => false);

            if (!visible || !editable) continue;

            const maxlength = await input
                .getAttribute('maxlength')
                .catch(() => null);

            const placeholder =
                (await input.getAttribute('placeholder').catch(() => '')) || '';

            const type =
                (await input.getAttribute('type').catch(() => '')) || '';

            if (
                maxlength === '10' ||
                /10\s*d[ií]gitos/i.test(placeholder) ||
                type.toLowerCase() === 'tel'
            ) {
                encontrados.push(input);
            }
        }

        if (!campoNumero && encontrados.length >= 1) {
            campoNumero = encontrados[0];
        }

        if (!campoConfirmacion && encontrados.length >= 2) {
            campoConfirmacion = encontrados[1];
        }
    }

    if (campoNumero && campoConfirmacion) {
        return {
            campoNumero,
            campoConfirmacion
        };
    }

    return null;
}

async function llenarNumeroTienda(page, numero, id) {
    const tituloRecarga = page.getByText(
        'Recarga saldo o compra paquetes para tu Amigo',
        { exact: false }
    ).first();

    if (await tituloRecarga.isVisible({ timeout: 1500 }).catch(() => false)) {
        await tituloRecarga.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);
    }

    const frames = page.frames();

    console.log(
        `[Telcel.com Usuario ${id}] 🧩 FRAMES DETECTADOS: ${frames.length}`
    );

    for (let i = 0; i < frames.length; i++) {
        console.log(
            `[Telcel.com Usuario ${id}] 🧩 FRAME ${i}:`,
            frames[i].url()
        );
    }

    let encontrados = null;
    const inicio = Date.now();

    while (Date.now() - inicio < 20000) {
        const framesActuales = page.frames();

        for (const frame of framesActuales) {
            encontrados = await buscarCamposNumeroEnFrame(frame);

            if (encontrados) {
                console.log(
                    `[Telcel.com Usuario ${id}] ✅ Campos encontrados en frame: ${frame.url()}`
                );
                break;
            }
        }

        if (encontrados) break;

        await page.waitForTimeout(300);
    }

    if (!encontrados) {
        console.log(`[Telcel.com Usuario ${id}] ❌ Formulario Telcel no terminó de renderizar`);

        for (const [i, frame] of page.frames().entries()) {
            const inputs = await frame.locator('input').evaluateAll(els =>
                els.map((el, index) => ({
                    index,
                    type: el.type,
                    id: el.id,
                    name: el.name,
                    placeholder: el.placeholder,
                    ariaLabel: el.getAttribute('aria-label'),
                    maxLength: el.maxLength
                }))
            ).catch(() => []);

            console.log(
                `[Telcel.com Usuario ${id}] FRAME ${i} INPUTS:`,
                JSON.stringify(inputs)
            );
        }

        await tomarCapturaTienda(page, id, 'error_campos_numero').catch(() => null);
        throw new Error('CAMPO_NUMERO_TELCEL_NO_ENCONTRADO');
    }

    const {
        campoNumero,
        campoConfirmacion
    } = encontrados;

    // Llenar campo 1 (Número Telcel)
    await campoNumero.scrollIntoViewIfNeeded();
    await campoNumero.click();
    await campoNumero.fill(numero);

    await campoNumero.dispatchEvent('input', { bubbles: true }).catch(() => {});
    await campoNumero.dispatchEvent('change', { bubbles: true }).catch(() => {});
    await campoNumero.dispatchEvent('blur', { bubbles: true }).catch(() => {});

    await page.waitForTimeout(400);

    // Llenar campo 2 (Confirmar el número Telcel)
    await campoConfirmacion.scrollIntoViewIfNeeded();
    await campoConfirmacion.click();
    await campoConfirmacion.fill(numero);

    await campoConfirmacion.dispatchEvent('input', { bubbles: true }).catch(() => {});
    await campoConfirmacion.dispatchEvent('change', { bubbles: true }).catch(() => {});
    await campoConfirmacion.dispatchEvent('blur', { bubbles: true }).catch(() => {});

    await page.waitForTimeout(300);

    // Comprobar con inputValue()
    const valor1 = await campoNumero.inputValue().catch(() => '');
    const valor2 = await campoConfirmacion.inputValue().catch(() => '');

    if (valor1 !== numero || valor2 !== numero || valor1.length !== 10 || valor2.length !== 10) {
        console.log(
            `[Telcel.com Usuario ${id}] ⚠️ Validación de valores: campo1_len=${valor1.length}, campo2_len=${valor2.length}, coinciden=${valor1 === valor2}`
        );
        throw new Error('VALIDACION_NUMERO_FALLIDA');
    }

    logTelcelTienda(id, '✅ [Telcel.com] Número 1 validado');
    logTelcelTienda(id, '✅ [Telcel.com] Número 2 validado');
    logTelcelTienda(id, `📱 [Telcel.com] Número ingresado: ${numero.slice(0, 3)}***${numero.slice(-2)}`);
}

async function seleccionarTipoCompraTienda(page, id) {
    logTelcelTienda(
        id,
        '📦 [Telcel.com] Seleccionando Paquetes Amigo Sin Límite'
    );

    const inicio = Date.now();
    let frame = null;
    let control = null;

    // 1. Localizar frame paymentservice.telcel.com y control div.select
    while (Date.now() - inicio < 15000) {
        frame = page.frames().find(f => f.url().includes('paymentservice.telcel.com')) || page.mainFrame();

        const selects = frame.locator('div.select[tabindex="0"], div.select');
        const count = await selects.count().catch(() => 0);

        for (let i = 0; i < count; i++) {
            const item = selects.nth(i);
            const visible = await item.isVisible({ timeout: 100 }).catch(() => false);
            if (!visible) continue;

            const txt = await item.innerText().catch(() => '');
            if ((/Tipo de compra|Elige una opci[oó]n/i.test(txt)) && txt.length < 150) {
                control = item;
                break;
            }
        }

        if (control) break;
        await page.waitForTimeout(300);
    }

    if (!control || !frame) {
        console.log(`[Telcel.com Usuario ${id}] ❌ No se encontró el control div.select para Tipo de Compra`);
        throw new Error('TIPO_COMPRA_NO_ENCONTRADO');
    }

    // 2. Posicionar sobre el control
    await control.scrollIntoViewIfNeeded();
    logTelcelTienda(id, '✅ [Telcel.com] Control Tipo de compra localizado');

    // 3. Abrir dropdown
    const arrow = control.locator('.form-field-action.form-field-arrow, .form-field-buttons [type="button"]').first();
    const container = control.locator('.form-field-container, .form-field').first();

    let abierto = false;
    if (await arrow.isVisible({ timeout: 400 }).catch(() => false)) {
        await arrow.click().catch(() => {});
        await page.waitForTimeout(400);
        abierto = await control.evaluate(el => el.classList.contains('select-open')).catch(() => false) ||
                  await control.locator('.select-options').isVisible({ timeout: 300 }).catch(() => false);
    }

    if (!abierto) {
        await container.click().catch(() => {});
        await page.waitForTimeout(400);
    }

    logTelcelTienda(id, '✅ [Telcel.com] Dropdown abierto');

    // 4. Buscar y hacer clic sobre "Paquetes Amigo Sin Límite"
    const btnOpcion = control.locator('.select-options button:has-text("Paquetes Amigo Sin Límite")').first();
    const btnFallback = frame.getByRole('button', { name: 'Paquetes Amigo Sin Límite', exact: true });

    let opcionClickeada = false;
    if (await btnOpcion.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btnOpcion.click();
        opcionClickeada = true;
    } else if (await btnFallback.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btnFallback.click();
        opcionClickeada = true;
    } else {
        const optCandidato = control.locator('.select-options button, .select-options [role="option"], .select-options div').filter({ hasText: 'Paquetes Amigo Sin Límite' }).first();
        if (await optCandidato.isVisible({ timeout: 1000 }).catch(() => false)) {
            await optCandidato.click();
            opcionClickeada = true;
        }
    }

    if (!opcionClickeada) {
        throw new Error('PAQUETES_AMIGO_SIN_LIMITE_NO_ENCONTRADO');
    }

    logTelcelTienda(id, '✅ [Telcel.com] Paquetes Amigo Sin Límite seleccionado');
    await page.waitForTimeout(400);

    // 5. Verificar que el .select muestre Paquetes Amigo Sin Límite
    const inicioVerif = Date.now();
    let confirmado = false;
    let textoSelect = '';
    let textoInput = '';

    while (Date.now() - inicioVerif < 5000) {
        textoSelect = await control.innerText().catch(() => '');
        textoInput = await control.locator('.form-field-input').innerText().catch(() => '');

        if (/Paquetes Amigo Sin L[ií]mite/i.test(textoInput) || (/Paquetes Amigo Sin L[ií]mite/i.test(textoSelect) && !textoSelect.includes('Elige una opción'))) {
            confirmado = true;
            break;
        }

        await page.waitForTimeout(250);
    }

    if (!confirmado) {
        const diag = await control.evaluate(el => {
            const btns = Array.from(el.querySelectorAll('.select-options button'));
            return {
                className: el.className,
                textSelect: el.innerText,
                textInput: el.querySelector('.form-field-input')?.innerText || '',
                countButtons: btns.length,
                buttonsText: btns.map(b => b.innerText.trim())
            };
        }).catch(() => null);

        console.log(`[Telcel.com Usuario ${id}] ❌ Diagnóstico de fallo en Tipo de Compra:`, JSON.stringify(diag, null, 2));
        throw new Error('TIPO_COMPRA_NO_CAMBIO_VALOR');
    }

    logTelcelTienda(id, '✅ [Telcel.com] Selección confirmada');

    // Diagnóstico antes de continuar
    let btnDisabled = 'desconocido';
    let ariaDisabled = 'desconocido';
    try {
        const btnCont = frame.locator('button:has-text("Continuar"), button[type="submit"]:has-text("Continuar")').first();
        if (await btnCont.count().catch(() => 0) > 0) {
            btnDisabled = !(await btnCont.isEnabled().catch(() => false));
            ariaDisabled = await btnCont.getAttribute('aria-disabled').catch(() => 'null');
        }
    } catch (_) {}

    console.log(`[Telcel.com Usuario ${id}] 🔎 Valor actual Tipo de compra: Paquetes Amigo Sin Límite`);
    console.log(`[Telcel.com Usuario ${id}] 🔎 Texto actual Tipo de compra: ${textoInput || textoSelect}`);
    console.log(`[Telcel.com Usuario ${id}] 🔎 Continuar disabled: ${btnDisabled}`);
    console.log(`[Telcel.com Usuario ${id}] 🔎 aria-disabled: ${ariaDisabled}`);
}

async function continuarTienda(page, id) {
    let botonEncontrado = null;
    let frameEncontrado = null;
    const inicio = Date.now();

    while (Date.now() - inicio < 15000) {
        const frames = page.frames();
        // Priorizar frame de paymentservice.telcel.com
        const framesOrdenados = [...frames].sort((a, b) => {
            const aMatch = a.url().includes('paymentservice.telcel.com') ? -1 : 1;
            const bMatch = b.url().includes('paymentservice.telcel.com') ? -1 : 1;
            return aMatch - bMatch;
        });

        for (const frame of framesOrdenados) {
            const candidatos = [
                frame.locator('button:has-text("Continuar")').first(),
                frame.locator('button[type="submit"]:has-text("Continuar")').first(),
                frame.locator('[role="button"]:has-text("Continuar")').first(),
                frame.locator('input[type="submit"][value*="Continuar" i]').first(),
                frame.locator('button[data-titulo*="Continuar" i]').first(),
                frame.locator('button.btn-primary:has-text("Continuar")').first()
            ];

            for (const loc of candidatos) {
                try {
                    if (await loc.isVisible({ timeout: 100 }).catch(() => false)) {
                        botonEncontrado = loc;
                        frameEncontrado = frame;
                        break;
                    }
                } catch (_) {}
            }

            if (botonEncontrado) break;
        }

        if (botonEncontrado) break;
        await page.waitForTimeout(300);
    }

    if (!botonEncontrado || !frameEncontrado) {
        console.log(`[Telcel.com Usuario ${id}] ❌ Diagnóstico de frames para Botón Continuar:`);
        for (const [i, frame] of page.frames().entries()) {
            const frameUrl = frame.url();
            const buttons = await frame.locator('button').evaluateAll(els =>
                els.map(el => ({ text: el.innerText.trim(), ariaLabel: el.getAttribute('aria-label'), type: el.type, visible: !!(el.offsetWidth || el.offsetHeight) }))
            ).catch(() => []);
            const roleButtons = await frame.locator('[role="button"]').evaluateAll(els =>
                els.map(el => ({ text: el.innerText.trim(), ariaLabel: el.getAttribute('aria-label') }))
            ).catch(() => []);
            const submitInputs = await frame.locator('input[type="submit"]').evaluateAll(els =>
                els.map(el => ({ value: el.value, id: el.id, name: el.name }))
            ).catch(() => []);
            const textoVisible = await frame.locator('body').innerText({ timeout: 500 }).catch(() => '');
            const matchTexto = textoVisible.match(/(.{0,40}Continuar.{0,40})/gi) || [];

            console.log(`[Telcel.com Usuario ${id}] FRAME ${i} (${frameUrl}):`, JSON.stringify({
                buttons: buttons.slice(0, 10),
                roleButtons,
                submitInputs,
                textoRelacionado: matchTexto
            }));
        }

        throw new Error('BOTON_CONTINUAR_NO_ENCONTRADO');
    }

    console.log(`[Telcel.com Usuario ${id}] ✅ [Telcel.com] Botón Continuar encontrado`);
    console.log(`[Telcel.com Usuario ${id}] 🧩 Frame: ${frameEncontrado.url()}`);

    await botonEncontrado.scrollIntoViewIfNeeded().catch(() => {});

    // Esperar hasta 10 segundos a que isEnabled() sea true
    const inicioEspera = Date.now();
    let habilitado = false;

    while (Date.now() - inicioEspera < 10000) {
        const activo = await botonEncontrado.isEnabled({ timeout: 200 }).catch(() => false);
        if (activo) {
            habilitado = true;
            break;
        }
        await page.waitForTimeout(250);
    }

    if (!habilitado) {
        throw new Error('BOTON_CONTINUAR_NO_HABILITADO');
    }

    logTelcelTienda(id, '✅ [Telcel.com] Botón Continuar habilitado');
    logTelcelTienda(id, '➡️ [Telcel.com] Continuando');

    await page.waitForTimeout(300);
    await botonEncontrado.click();
    await page.waitForTimeout(2000);
}

async function seleccionarMontoTienda(page, monto, id) {
    const txtMonto = String(monto).replace('$', '').trim();
    console.log(`[Telcel.com Usuario ${id}] 💲 Buscando monto exacto: $${txtMonto}`);

    const regexPrecio = new RegExp(`\\$\\s*${txtMonto}(?:\\.00)?(?!\\d)`, 'i');

    const inicio = Date.now();
    let frameEncontrado = null;
    let botonEncontrado = null;
    let tarjetaTexto = '';

    while (Date.now() - inicio < 25000) {
        const frames = page.frames();
        const framesOrdenados = [...frames].sort((a, b) => {
            const aMatch = a.url().includes('paymentservice.telcel.com') ? -1 : 1;
            const bMatch = b.url().includes('paymentservice.telcel.com') ? -1 : 1;
            return aMatch - bMatch;
        });

        for (const frame of framesOrdenados) {
            const botones = frame.locator('button:has-text("Lo quiero"), [role="button"]:has-text("Lo quiero")');
            const totalBotones = await botones.count().catch(() => 0);

            for (let b = 0; b < totalBotones; b++) {
                const btn = botones.nth(b);
                const isVis = await btn.isVisible({ timeout: 50 }).catch(() => false);
                if (!isVis) continue;

                // Evaluar el contenedor más pequeño que contiene este botón
                const infoCard = await btn.evaluate((buttonEl, args) => {
                    const { montoBuscado } = args;
                    const regexPrec = new RegExp(`\\$\\s*${montoBuscado}(?:\\.00)?(?!\\d)`, 'i');

                    let current = buttonEl.parentElement;
                    let candidateCard = null;

                    // Subir en el árbol DOM hasta encontrar el contenedor que tenga texto del paquete
                    while (current && current !== document.body && current !== document.documentElement) {
                        const txt = (current.innerText || '').trim();
                        const btnsLoQuiero = Array.from(current.querySelectorAll('button, [role="button"]')).filter(
                            el => (el.innerText || '').includes('Lo quiero') && (el.offsetWidth > 0 || el.offsetHeight > 0)
                        );

                        const countLoQuiero = btnsLoQuiero.length;
                        const preciosMonetarios = txt.match(/\$\s*\d+(?:\.\d{2})?/g) || [];
                        const precioMonetarioDetectado = preciosMonetarios.length > 0 ? preciosMonetarios[0].replace(/\s+/g, '') : 'No detectado';
                        const coincidePrecioExacto = regexPrec.test(txt);

                        if (countLoQuiero === 1 && preciosMonetarios.length > 0) {
                            candidateCard = {
                                text: txt.slice(0, 200).replace(/\n+/g, ' | '),
                                countLoQuiero,
                                precioMonetarioDetectado,
                                coincidePrecioExacto
                            };
                            break;
                        }

                        if (countLoQuiero > 1) {
                            // Si contiene más de 1 botón "Lo quiero", es un contenedor padre y debe descartarse
                            break;
                        }

                        current = current.parentElement;
                    }

                    if (!candidateCard) {
                        const parentTxt = (buttonEl.parentElement?.innerText || '').slice(0, 100).replace(/\n+/g, ' ');
                        const precios = parentTxt.match(/\$\s*\d+(?:\.\d{2})?/g) || [];
                        return {
                            found: false,
                            text: parentTxt,
                            countLoQuiero: 1,
                            precioMonetarioDetectado: precios.length > 0 ? precios[0].replace(/\s+/g, '') : 'No detectado',
                            coincidePrecioExacto: regexPrec.test(parentTxt)
                        };
                    }

                    return {
                        found: candidateCard.coincidePrecioExacto && candidateCard.countLoQuiero === 1,
                        ...candidateCard
                    };
                }, { montoBuscado: txtMonto }).catch(() => null);

                if (!infoCard) continue;

                console.log(`[Telcel.com Usuario ${id}] 🔍 Candidato paquete:\n` +
                            `  PRECIO_SOLICITADO=$${txtMonto}\n` +
                            `  PRECIO_MONETARIO_DETECTADO=${infoCard.precioMonetarioDetectado}\n` +
                            `  COINCIDE_PRECIO_EXACTO=${infoCard.coincidePrecioExacto}\n` +
                            `  botonesLoQuiero=${infoCard.countLoQuiero}\n` +
                            `  frame=${frame.url()}`);

                if (infoCard.found || (infoCard.countLoQuiero === 1 && infoCard.coincidePrecioExacto)) {
                    botonEncontrado = btn;
                    frameEncontrado = frame;
                    tarjetaTexto = infoCard.text;
                    break;
                }
            }

            if (botonEncontrado) break;
        }

        if (botonEncontrado) break;
        await page.waitForTimeout(400);
    }

    if (!botonEncontrado || !frameEncontrado) {
        throw new Error(`MONTO_${txtMonto}_NO_ENCONTRADO`);
    }

    console.log(`[Telcel.com Usuario ${id}] ✅ Paquete exacto $${txtMonto} localizado`);
    console.log(`[Telcel.com Usuario ${id}] 📦 Texto paquete: ${tarjetaTexto}`);

    await botonEncontrado.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);
    await botonEncontrado.click();
    await page.waitForTimeout(2000);

    // Verificación de la pantalla de resumen antes de continuar
    const inicioResumen = Date.now();
    let resumenValido = false;

    while (Date.now() - inicioResumen < 10000) {
        for (const frame of page.frames()) {
            const textoBody = await frame.locator('body').innerText({ timeout: 500 }).catch(() => '');
            if (!textoBody) continue;

            const tienePrecio = regexPrecio.test(textoBody);

            if (tienePrecio || /Monto a pagar/i.test(textoBody)) {
                // Validar que no contenga un monto diferente después de "Monto a pagar"
                const matchMontoPagar = textoBody.match(/Monto a pagar:?\s*\$?\s*(\d+)/i) || textoBody.match(/Total:?\s*\$?\s*(\d+)/i);
                if (matchMontoPagar && matchMontoPagar[1]) {
                    const montDetectado = matchMontoPagar[1];
                    if (montDetectado !== txtMonto) {
                        console.log(`[Telcel.com Usuario ${id}] ❌ Error: Resumen muestra $${montDetectado} en lugar de $${txtMonto}`);
                        throw new Error('MONTO_SELECCIONADO_INCORRECTO');
                    }
                }

                if (tienePrecio) {
                    resumenValido = true;
                    break;
                }
            }
        }

        if (resumenValido) break;
        await page.waitForTimeout(300);
    }

    console.log(`[Telcel.com Usuario ${id}] ✅ Resumen confirmado para monto $${txtMonto}`);
}

async function seleccionarMetodoTarjetaTienda(page, id) {
    console.log(`[Telcel.com Usuario ${id}] 💳 Buscando "Tarjeta de crédito o débito"`);

    const inicio = Date.now();
    let frameEncontrado = null;
    let radioEncontrado = null;
    let labelEncontrado = null;

    while (Date.now() - inicio < 20000) {
        const frames = page.frames();
        const framesOrdenados = [...frames].sort((a, b) => {
            const aMatch = a.url().includes('paymentservice.telcel.com') ? -1 : 1;
            const bMatch = b.url().includes('paymentservice.telcel.com') ? -1 : 1;
            return aMatch - bMatch;
        });

        for (const frame of framesOrdenados) {
            const selsRadio = [
                'input[type="radio"][name="paymentType"][value="CARD"]',
                'input[name="paymentType"][value="CARD"]'
            ];

            for (const sel of selsRadio) {
                const r = frame.locator(sel).first();
                if (await r.count().catch(() => 0) > 0) {
                    radioEncontrado = r;
                    frameEncontrado = frame;
                    break;
                }
            }

            if (!radioEncontrado) {
                const lbl = frame.locator('label:has-text("Tarjeta de crédito o débito")').first();
                if (await lbl.isVisible({ timeout: 100 }).catch(() => false)) {
                    labelEncontrado = lbl;
                    frameEncontrado = frame;
                    const r = frame.locator('input[type="radio"][value="CARD"]').first();
                    if (await r.count().catch(() => 0) > 0) {
                        radioEncontrado = r;
                    }
                    break;
                }
            }

            if (radioEncontrado || labelEncontrado) break;
        }

        if (radioEncontrado || labelEncontrado) break;
        await page.waitForTimeout(300);
    }

    if (!frameEncontrado || (!radioEncontrado && !labelEncontrado)) {
        throw new Error('OPCION_TARJETA_NO_ENCONTRADA');
    }

    console.log(`[Telcel.com Usuario ${id}] 🧩 Opción CARD localizada en frame: ${frameEncontrado.url()}`);

    const elementoInteraccion = radioEncontrado || labelEncontrado;
    await elementoInteraccion.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);

    // Seleccionar normalmente
    if (radioEncontrado && (await radioEncontrado.isVisible({ timeout: 200 }).catch(() => false))) {
        await radioEncontrado.check().catch(async () => {
            await radioEncontrado.click().catch(() => {});
        });
    } else if (labelEncontrado) {
        await labelEncontrado.click().catch(() => {});
    }

    // Verificar isChecked()
    const inicioCheck = Date.now();
    let marcado = false;

    while (Date.now() - inicioCheck < 5000) {
        if (radioEncontrado) {
            marcado = await radioEncontrado.isChecked().catch(() => false);
            if (marcado) break;
        }
        await page.waitForTimeout(200);
    }

    if (!marcado && radioEncontrado) {
        await radioEncontrado.check({ force: false }).catch(async () => {
            await (labelEncontrado || radioEncontrado).click().catch(() => {});
        });
        marcado = await radioEncontrado.isChecked().catch(() => false);
    }

    console.log(`[Telcel.com Usuario ${id}] ✅ Radio CARD seleccionado`);

    // Comprobar que aparezca el formulario de tarjeta
    const inicioForm = Date.now();
    let formVisible = false;

    while (Date.now() - inicioForm < 10000) {
        const textBody = await frameEncontrado.locator('body').innerText({ timeout: 500 }).catch(() => '');
        const tieneCampos = 
            /N[uú]mero de tarjeta|tarjeta/i.test(textBody) &&
            /vencimiento|MM\/AA/i.test(textBody) &&
            /CVV|CVC/i.test(textBody);

        const inputTarj = frameEncontrado.locator('input[placeholder*="0000 0000"], input[autocomplete="cc-number"], input[name*="card" i], input[id*="card" i]').first();
        const inputVisible = await inputTarj.isVisible({ timeout: 100 }).catch(() => false);

        if (tieneCampos || inputVisible) {
            formVisible = true;
            break;
        }

        await page.waitForTimeout(300);
    }

    console.log(`[Telcel.com Usuario ${id}] ✅ Formulario de tarjeta visible`);
    return { frame: frameEncontrado };
}

async function aceptarTerminosTienda(page, id) {
    console.log(`[Telcel.com Usuario ${id}] ☑️ Buscando casilla de Términos y Condiciones`);

    const inicio = Date.now();
    let frameEncontrado = null;
    let chkEncontrado = null;

    while (Date.now() - inicio < 15000) {
        const frames = page.frames();
        const framesOrdenados = [...frames].sort((a, b) => {
            const aMatch = a.url().includes('paymentservice.telcel.com') ? -1 : 1;
            const bMatch = b.url().includes('paymentservice.telcel.com') ? -1 : 1;
            return aMatch - bMatch;
        });

        for (const frame of framesOrdenados) {
            // 1. Selector prioritario: input[type="checkbox"][name="tycos"]
            const chkTycos = frame.locator('input[type="checkbox"][name="tycos"]').first();
            if (await chkTycos.count().catch(() => 0) > 0) {
                chkEncontrado = chkTycos;
                frameEncontrado = frame;
                break;
            }

            // 2. Fallback por texto si no se encuentra por name="tycos"
            const checkboxes = await frame.locator('input[type="checkbox"]').all().catch(() => []);
            for (const chk of checkboxes) {
                const idInput = await chk.getAttribute('id').catch(() => null);
                let textoAsociado = '';

                if (idInput) {
                    const locLbl = frame.locator(`label[for="${idInput}"]`).first();
                    if (await locLbl.count().catch(() => 0) > 0) {
                        textoAsociado = await locLbl.innerText({ timeout: 200 }).catch(() => '');
                    }
                }
                if (!textoAsociado) {
                    const parent = chk.locator('..');
                    textoAsociado = await parent.innerText({ timeout: 200 }).catch(() => '');
                }
                if (!textoAsociado) {
                    const grandParent = chk.locator('../..');
                    textoAsociado = await grandParent.innerText({ timeout: 200 }).catch(() => '');
                }

                if (/He le[ií]do y estoy de acuerdo|T[eé]rminos y Condiciones/i.test(textoAsociado)) {
                    chkEncontrado = chk;
                    frameEncontrado = frame;
                    break;
                }
            }
            if (chkEncontrado) break;
        }

        if (chkEncontrado) break;
        await page.waitForTimeout(300);
    }

    const encontrado = chkEncontrado !== null && frameEncontrado !== null;
    console.log(`[Telcel.com Usuario ${id}] TYCOS_ENCONTRADO=${encontrado}`);

    if (!encontrado) {
        throw new Error('TERMINOS_CHECKBOX_NO_ENCONTRADO');
    }

    await chkEncontrado.scrollIntoViewIfNeeded().catch(() => {});

    // Leer y registrar ANTES
    const isCheckedAntes = await chkEncontrado.isChecked().catch(() => false);
    console.log(`[Telcel.com Usuario ${id}] TYCOS_CHECKED_ANTES=${isCheckedAntes}`);

    if (isCheckedAntes) {
        console.log(`[Telcel.com Usuario ${id}] ✅ TYCOS ya estaba seleccionado`);
        return true;
    }

    // Si devuelve false, interactuar con el checkbox (usando force y timeout breve para Material UI)
    await chkEncontrado.check({ force: true, timeout: 1500 }).catch(async () => {
        await chkEncontrado.click({ force: true, timeout: 1500 }).catch(() => {});
    });

    await page.waitForTimeout(300);

    let marcado = await chkEncontrado.isChecked().catch(() => false);

    // Si continúa false, interactuar con el componente contenedor Material UI (span.MuiCheckbox-root o label)
    if (!marcado) {
        const muiParent = chkEncontrado.locator('xpath=ancestor::span[contains(@class, "MuiCheckbox-root")] | ..').first();
        if (await muiParent.count().catch(() => 0) > 0) {
            await muiParent.click({ force: true, timeout: 1500 }).catch(() => {});
        } else {
            await chkEncontrado.evaluate(input => {
                input.click();
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }).catch(() => {});
        }
        await page.waitForTimeout(300);
        marcado = await chkEncontrado.isChecked().catch(() => false);
    }

    // Segunda comprobación diagnóstica: leer clase del padre MuiCheckbox-root
    const clasePadre = (await chkEncontrado.locator('..').getAttribute('class').catch(() => '')) || '';
    const muiChecked = clasePadre.includes('Mui-checked');
    console.log(`[Telcel.com Usuario ${id}] TYCOS_MUI_CHECKED=${muiChecked}`);

    const checkedDespues = marcado || muiChecked;
    console.log(`[Telcel.com Usuario ${id}] TYCOS_CHECKED_DESPUES=${checkedDespues}`);

    if (checkedDespues === true) {
        console.log(`[Telcel.com Usuario ${id}] ✅ Términos y Condiciones realmente aceptados`);
        return true;
    } else {
        throw new Error('TERMINOS_CHECKBOX_NO_MARCADO');
    }
}

async function llenarYEjecutarPagoTienda(page, datos, id) {
    const { tarjeta, mes, anio, cvv, cp_auto, correo_auto } = datos;
    const cleanTarjeta = String(tarjeta).replace(/\D/g, '');
    const cleanCvv = String(cvv).replace(/\D/g, '');
    const exp = `${String(mes).padStart(2, '0')}/${String(anio).slice(-2)}`;
    const cp = cp_auto || (datos.direccion_valida && datos.direccion_valida.cp) || '06000';
    const correo = correo_auto || 'recargas.telcel.auto@gmail.com';

    logTelcelTienda(id, `📝 Auto-llenando formulario de pago:`);
    logTelcelTienda(id, `   - Tarjeta: ${cleanTarjeta.slice(0, 4)} **** **** ${cleanTarjeta.slice(-4)}`);
    logTelcelTienda(id, `   - Vencimiento: ${exp} | CVV: ***`);
    logTelcelTienda(id, `   - CP generado: ${cp}`);
    logTelcelTienda(id, `   - Correo generado: ${correo}`);

    const frame = page.frames().find(f => f.url().includes('paymentservice.telcel.com')) || page.mainFrame();

    // Helper interno para localizar input visible
    async function obtenerInput(selectores) {
        for (const sel of selectores) {
            try {
                const loc = frame.locator(sel).first();
                if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
                    return loc;
                }
            } catch (_) {}
        }
        for (const sel of selectores) {
            try {
                const loc = frame.locator(sel).first();
                if (await loc.count().catch(() => 0) > 0) {
                    return loc;
                }
            } catch (_) {}
        }
        return null;
    }

    // 1. Número de tarjeta
    const selsTarjeta = [
        'input[autocomplete="cc-number"]',
        'input[name*="cardNumber" i]',
        'input[name*="tarjeta" i]',
        'input[id*="cardNumber" i]',
        'input[id*="tarjeta" i]',
        'div:has(> label:has-text("Número de tarjeta")) input',
        'label:has-text("Número de tarjeta") ~ input',
        'input[placeholder*="0000 0000 0000 0000"]',
        'input[placeholder*="0000 0000"]'
    ];
    const inputTarjeta = await obtenerInput(selsTarjeta);
    if (inputTarjeta) {
        await inputTarjeta.scrollIntoViewIfNeeded().catch(() => {});
        await inputTarjeta.click({ force: true }).catch(() => {});
        await inputTarjeta.fill('').catch(() => {});
        await inputTarjeta.pressSequentially(cleanTarjeta, { delay: 30 }).catch(async () => {
            await inputTarjeta.fill(cleanTarjeta);
        });
        await inputTarjeta.dispatchEvent('input', { bubbles: true }).catch(() => {});
        await inputTarjeta.dispatchEvent('change', { bubbles: true }).catch(() => {});
        await inputTarjeta.dispatchEvent('blur', { bubbles: true }).catch(() => {});
        await page.waitForTimeout(300);
    }

    // 2. Fecha de vencimiento (MM/AA)
    const selsExp = [
        'input[autocomplete="cc-exp"]',
        'input[name*="exp" i]',
        'input[name*="vencimiento" i]',
        'input[id*="exp" i]',
        'input[id*="vencimiento" i]',
        'div:has(> label:has-text("Fecha de vencimiento")) input',
        'label:has-text("Fecha de vencimiento") ~ input',
        'input[placeholder*="MM/AA"]',
        'input[placeholder*="MM / AA"]'
    ];
    const inputExp = await obtenerInput(selsExp);
    if (inputExp) {
        await inputExp.scrollIntoViewIfNeeded().catch(() => {});
        await inputExp.click({ force: true }).catch(() => {});
        await inputExp.fill('').catch(() => {});
        await inputExp.pressSequentially(exp, { delay: 30 }).catch(async () => {
            await inputExp.fill(exp);
        });
        await inputExp.dispatchEvent('input', { bubbles: true }).catch(() => {});
        await inputExp.dispatchEvent('change', { bubbles: true }).catch(() => {});
        await inputExp.dispatchEvent('blur', { bubbles: true }).catch(() => {});
        await page.waitForTimeout(300);
    }

    // 3. CVV (Selectores específicos para evitar colisión con CP o Tarjeta)
    const selsCvv = [
        'input[autocomplete="cc-csc"]',
        'input[name*="cvv" i]',
        'input[name*="cvc" i]',
        'input[name*="securityCode" i]',
        'input[id*="cvv" i]',
        'input[id*="cvc" i]',
        'div:has(> label:has-text("CVV")) input',
        'div:has-text("*CVV") input',
        'label:has-text("CVV") ~ input',
        'input[maxlength="4"][placeholder="000"]',
        'input[maxlength="3"]',
        'input[placeholder="000"]'
    ];
    const inputCvv = await obtenerInput(selsCvv);
    if (inputCvv) {
        await inputCvv.scrollIntoViewIfNeeded().catch(() => {});
        await inputCvv.click({ force: true }).catch(() => {});
        await inputCvv.fill('').catch(() => {});
        await inputCvv.pressSequentially(cleanCvv, { delay: 30 }).catch(async () => {
            await inputCvv.fill(cleanCvv);
        });
        await inputCvv.dispatchEvent('input', { bubbles: true }).catch(() => {});
        await inputCvv.dispatchEvent('change', { bubbles: true }).catch(() => {});
        await inputCvv.dispatchEvent('blur', { bubbles: true }).catch(() => {});
        await page.waitForTimeout(300);
    }

    // 4. Código Postal
    const selsCp = [
        'input[autocomplete="postal-code"]',
        'input[name*="postal" i]',
        'input[name*="zip" i]',
        'input[name="cp"]',
        'input[id*="postal" i]',
        'input[id*="zip" i]',
        'input[id="cp"]',
        'div:has(> label:has-text("Código postal")) input',
        'label:has-text("Código postal") ~ input',
        'div:has-text("Código postal") input',
        'input[placeholder="00000"]',
        'input[placeholder*="00000"]'
    ];
    const inputCp = await obtenerInput(selsCp);
    if (inputCp) {
        await inputCp.scrollIntoViewIfNeeded().catch(() => {});
        await inputCp.click({ force: true }).catch(() => {});
        await inputCp.fill('').catch(() => {});
        await inputCp.pressSequentially(String(cp), { delay: 20 }).catch(async () => {
            await inputCp.fill(String(cp));
        });
        await inputCp.dispatchEvent('input', { bubbles: true }).catch(() => {});
        await inputCp.dispatchEvent('change', { bubbles: true }).catch(() => {});
        await inputCp.dispatchEvent('blur', { bubbles: true }).catch(() => {});
        await page.waitForTimeout(300);
    }

    // 5. Correo electrónico
    const selsCorreo = [
        'input[autocomplete="email"]',
        'input[type="email"]',
        'input[name*="email" i]',
        'input[name*="correo" i]',
        'input[id*="email" i]',
        'input[id*="correo" i]',
        'div:has(> label:has-text("Correo electrónico")) input',
        'label:has-text("Correo electrónico") ~ input',
        'div:has-text("Correo electrónico") input',
        'input[placeholder*="mail@dominio.com"]',
        'input[placeholder*="@"]'
    ];
    const inputCorreo = await obtenerInput(selsCorreo);
    if (inputCorreo) {
        await inputCorreo.scrollIntoViewIfNeeded().catch(() => {});
        await inputCorreo.click({ force: true }).catch(() => {});
        await inputCorreo.fill('').catch(() => {});
        await inputCorreo.pressSequentially(correo, { delay: 15 }).catch(async () => {
            await inputCorreo.fill(correo);
        });
        await inputCorreo.dispatchEvent('input', { bubbles: true }).catch(() => {});
        await inputCorreo.dispatchEvent('change', { bubbles: true }).catch(() => {});
        await inputCorreo.dispatchEvent('blur', { bubbles: true }).catch(() => {});
        await page.waitForTimeout(400);
    }

    // 6. Checkbox Términos y Condiciones (UNA SOLA VEZ)
    await aceptarTerminosTienda(page, id);
    await page.waitForTimeout(400);

    // 7. Esperar y verificar activación del botón Pagar (Diagnóstico)
    logTelcelTienda(id, `⏳ Verificando activación del botón Pagar...`);
    const selsPagar = [
        'button.btn.btn-primary:has-text("Pagar")',
        'button[type="submit"]:has-text("Pagar")',
        'button:has-text("Pagar")'
    ];
    let btnPagar = null;
    for (const sel of selsPagar) {
        const loc = frame.locator(sel).first();
        if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
            btnPagar = loc;
            break;
        }
    }
    if (!btnPagar) {
        throw new Error('BOTON_PAGAR_NO_DISPONIBLE');
    }

    const tInicioPagar = Date.now();
    let visible = false;
    let enabled = false;
    let disabledAttr = null;
    let ariaDisabled = null;

    while (Date.now() - tInicioPagar < 10000) {
        visible = await btnPagar.isVisible().catch(() => false);
        enabled = await btnPagar.isEnabled().catch(() => false);
        disabledAttr = await btnPagar.getAttribute('disabled').catch(() => null);
        ariaDisabled = await btnPagar.getAttribute('aria-disabled').catch(() => null);

        if (enabled) break;
        await page.waitForTimeout(400);
    }

    console.log(`[Telcel.com Usuario ${id}] PAGAR_VISIBLE=${visible}`);
    console.log(`[Telcel.com Usuario ${id}] PAGAR_ENABLED=${enabled}`);
    console.log(`[Telcel.com Usuario ${id}] PAGAR_DISABLED=${disabledAttr !== null ? disabledAttr : 'false'}`);
    console.log(`[Telcel.com Usuario ${id}] PAGAR_ARIA_DISABLED=${ariaDisabled !== null ? ariaDisabled : 'false'}`);

    // Diagnóstico de campos con aria-invalid="true" o mensajes visibles de validación
    const invalidInputs = await frame.locator('input[aria-invalid="true"], [aria-invalid="true"]').all().catch(() => []);
    for (const c of invalidInputs) {
        const name = await c.getAttribute('name').catch(() => '');
        const idFld = await c.getAttribute('id').catch(() => '');
        const val = await c.inputValue().catch(() => '');
        console.warn(`[Telcel.com Usuario ${id}] ⚠️ Campo con aria-invalid="true": name="${name}", id="${idFld}", valor="${val}"`);
    }

    const msgsError = await frame.locator('.Mui-error, .invalid-feedback, .error-message, [role="alert"]').allInnerTexts().catch(() => []);
    const msgsLimpios = msgsError.map(m => m.trim()).filter(m => m.length > 0 && !/^\s*$/.test(m));
    if (msgsLimpios.length > 0) {
        console.warn(`[Telcel.com Usuario ${id}] ⚠️ Mensajes de validación visibles:`, msgsLimpios.join(' | '));
    }

    if (!enabled) {
        logTelcelTienda(id, `⏸️ Diagnóstico completado: Botón Pagar permanece deshabilitado. No se forzó el clic.`);
        return null;
    }

    // Clic en Pagar únicamente si enabled === true
    logTelcelTienda(id, `💳 Ejecutando clic en botón Pagar...`);
    const tiempoClic = Date.now();
    await btnPagar.scrollIntoViewIfNeeded().catch(() => {});
    await btnPagar.click();

    return tiempoClic;
}

async function extraerDatosConfirmacionTienda(page, datos) {
    const { numero, monto } = datos;
    let textoPagina = '';
    for (const frame of page.frames()) {
        const txt = await frame.locator('body').innerText({ timeout: 1000 }).catch(() => '');
        if (txt) textoPagina += '\n' + txt;
    }

    let folioTelcel = '';
    const matchFolio = textoPagina.match(/Folio Telcel:?\s*([0-9A-Z]+)/i) || 
                       textoPagina.match(/Folio:?\s*([0-9A-Z]+)/i);
    if (matchFolio && matchFolio[1]) {
        folioTelcel = matchFolio[1].trim();
    } else {
        folioTelcel = 'No visible';
    }

    let fechaHora = '';
    const matchFecha = textoPagina.match(/Fecha y hora:?\s*([0-9\/\:\s h]+)/i);
    if (matchFecha && matchFecha[1]) {
        fechaHora = matchFecha[1].trim();
    } else {
        fechaHora = 'No visible';
    }

    let vigencia = '';
    const matchVigencia = textoPagina.match(/Vigencia:?\s*([^\n\r]+)/i);
    if (matchVigencia && matchVigencia[1]) {
        vigencia = matchVigencia[1].trim();
    } else {
        vigencia = 'No visible';
    }

    let nombrePaquete = `Amigo Sin Límite ${monto}`;
    const matchPaquete = textoPagina.match(/Paquete:?\s*([^\n\r]+)/i);
    if (matchPaquete && matchPaquete[1]) {
        nombrePaquete = matchPaquete[1].trim();
    }

    return {
        numero,
        monto,
        nombrePaquete,
        fechaHora,
        vigencia,
        folioTelcel
    };
}

async function monitorearRespuestaPagoTienda(page, tiempoClic, id) {
    logTelcelTienda(id, `🔍 Monitoreando respuesta final del portal de pagos...`);
    const timeoutMaximo = 65000;
    const inicio = Date.now();
    let candidatoFinal = null;
    let repeticionesFinal = 0;
    let vioProcesando = false;

    const confirmarFinal = async (tipo, extra = {}) => {
        if (candidatoFinal === tipo) {
            repeticionesFinal += 1;
        } else {
            candidatoFinal = tipo;
            repeticionesFinal = 1;
        }

        if (repeticionesFinal < 3) return null;

        // Esperar a que el icono/tache/círculo/comprobante termine de renderizar.
        await page.waitForTimeout(1500);
        const segundos = (Date.now() - tiempoClic) / 1000;
        logTelcelTienda(id, `✅ Resultado final estable ${tipo} detectado en ${segundos.toFixed(1)}s`);
        return { tipo, segundos, ...extra };
    };

    while (Date.now() - inicio < timeoutMaximo) {
        let textoPagina = '';
        for (const frame of page.frames()) {
            const txt = await frame.locator('body').innerText({ timeout: 700 }).catch(() => '');
            if (txt) textoPagina += '\n' + txt;
        }

        const tiempoRespuestaSegundos = (Date.now() - tiempoClic) / 1000;

        // ÉXITO: sólo señales finales fuertes. Se evita "Compra de paquete" por ser texto que puede aparecer antes de terminar el cobro.
        if (/¡?Gracias por tu compra!?|Folio Telcel\s*:?\s*[0-9A-Z]+|comprobante por SMS|recarga exitosa|transacci[oó]n exitosa|recarga completada|pago exitoso|pago aprobado|pago realizado/i.test(textoPagina)) {
            const r = await confirmarFinal('EXITO');
            if (r) return r;
        }
        // RECHAZO BANCARIO / TACHE FINAL
        else if (/pago rechazado|transacci[oó]n rechazada|tarjeta rechazada|tarjeta declinada|operaci[oó]n declinada|no autorizad[ao]|fondos insuficientes|saldo insuficiente|no se pudo completar (?:el|tu) pago|no pudimos procesar (?:el|tu) pago/i.test(textoPagina)) {
            const r = await confirmarFinal('RECHAZO_BANCARIO');
            if (r) return r;
        }
        // Forma de pago no disponible / círculo de aviso
        else if (/Por el momento la forma de pago seleccionada no est[aá] disponible/i.test(textoPagina)) {
            const esRapido = tiempoRespuestaSegundos < 5.0;
            const r = await confirmarFinal('FORMA_PAGO_NO_DISPONIBLE', { esRapido });
            if (r) return r;
        }
        // Error de conexión / error final visible
        else if (/error de conexi[oó]n|no pudimos conectar|fall[oó] la conexi[oó]n|problemas de conexi[oó]n|ocurri[oó] un error|int[eé]ntalo m[aá]s tarde/i.test(textoPagina)) {
            const r = await confirmarFinal('ERROR_CONEXION');
            if (r) return r;
        }
        // Mientras siga procesando NO se toma captura ni se finaliza.
        else if (/estamos procesando tu pago|procesando tu pago|procesando|pago en proceso|transacci[oó]n en proceso|validando transacci[oó]n|espera un momento/i.test(textoPagina)) {
            candidatoFinal = null;
            repeticionesFinal = 0;
            if (!vioProcesando) {
                vioProcesando = true;
                logTelcelTienda(id, `⏳ Telcel.com sigue procesando; esperando tache/círculo/comprobante final...`);
            }
        } else {
            candidatoFinal = null;
            repeticionesFinal = 0;
        }

        await page.waitForTimeout(700);
    }

    return {
        tipo: vioProcesando ? 'PROCESANDO_TIMEOUT' : 'TIMEOUT',
        segundos: (Date.now() - tiempoClic) / 1000
    };
}

async function tomarCapturaTienda(page, id, etiqueta = 'precheckout') {
    const tempDir = os.tmpdir();
    const ruta = path.join(tempDir, `telcel_tienda_${id}_${etiqueta}_${Date.now()}.png`);
    await page.screenshot({ path: ruta, fullPage: false });
    return ruta;
}

async function flujoTelcelTienda(ctx, id, datos) {
    const { numero, monto, tarjeta } = datos;
    let sesion = null;
    let page = null;

    try {
        const ult4 = tarjeta ? tarjeta.slice(-4) : '****';
        await ctx.replyWithHTML(
            `🟣 <b>TELCEL.COM — PROCESANDO RECARGA</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📱 <b>Línea:</b> <code>${numero}</code>\n` +
            `💲 <b>Monto:</b> $${monto} MXN\n` +
            `💳 <b>Tarjeta:</b> <code>**** ${ult4}</code>\n\n` +
            `⏳ Abriendo navegador y procesando pago...`
        ).catch(() => {});

        sesion = await crearNavegadorTienda(id);
        page = sesion.page;

        logTelcelTienda(id, `🌐 [Telcel.com] Iniciando navegación...`);
        const inicioCargaTienda = Date.now();

        await page.goto(URL_TELCEL_TIENDA, {
            waitUntil: 'commit',
            timeout: 30000
        });

        logTelcelTienda(
            id,
            `✅ [Telcel.com] Servidor respondió en ${Date.now() - inicioCargaTienda} ms`
        );

        await page.waitForLoadState('domcontentloaded', {
            timeout: 12000
        }).catch(() => {
            logTelcelTienda(
                id,
                '⚠️ [Telcel.com] DOMContentLoaded tardó; continuando por detección del formulario'
            );
        });

        await aceptarCookiesTienda(page);

        logTelcelTienda(id, '⏳ [Telcel.com] Esperando formulario Telcel...');

        const inicioFormulario = Date.now();

        const tituloRecarga = page.getByText(
            'Recarga saldo o compra paquetes para tu Amigo',
            { exact: false }
        ).first();

        await tituloRecarga.waitFor({
            state: 'visible',
            timeout: 20000
        });

        logTelcelTienda(
            id,
            `✅ [Telcel.com] Formulario detectado en ${Date.now() - inicioFormulario} ms`
        );

        await tituloRecarga.scrollIntoViewIfNeeded().catch(() => {});

        logTelcelTienda(id, '📱 [Telcel.com] Buscando campos de número...');

        // PASO 1: Ingresar número en ambas casillas
        await llenarNumeroTienda(page, numero, id);
        await page.waitForTimeout(600);

        const verifNumTienda1 = await detectarNumeroInvalido(page);
        if (verifNumTienda1 && verifNumTienda1.esInvalido) {
            const err = new Error('NUMERO_INVALIDO');
            err.esNumeroInvalido = true;
            err.mensajeInvalido = verifNumTienda1.mensaje;
            throw err;
        }

        // PASO 2: Seleccionar tipo de compra (Paquetes Amigo Sin Límite)
        await seleccionarTipoCompraTienda(page, id);

        // PASO 3: Continuar
        await continuarTienda(page, id);

        const verifNumTienda2 = await detectarNumeroInvalido(page);
        if (verifNumTienda2 && verifNumTienda2.esInvalido) {
            const err = new Error('NUMERO_INVALIDO');
            err.esNumeroInvalido = true;
            err.mensajeInvalido = verifNumTienda2.mensaje;
            throw err;
        }

        // PASO 4: Seleccionar monto
        await seleccionarMontoTienda(page, monto, id);

        // PASO 5: Seleccionar método de pago (Tarjeta de crédito o débito)
        await seleccionarMetodoTarjetaTienda(page, id);

        // PASO 6: Llenar datos de tarjeta y pulsar Pagar
        const tiempoClic = await llenarYEjecutarPagoTienda(page, datos, id);

        // PASO 7: Monitorear respuesta de pago
        const resultado = await monitorearRespuestaPagoTienda(page, tiempoClic, id);

        // Captura únicamente cuando existe un resultado final confirmado.
        let capturaResultadoTienda = null;
        if (['EXITO', 'RECHAZO_BANCARIO', 'FORMA_PAGO_NO_DISPONIBLE', 'ERROR_CONEXION'].includes(resultado.tipo) && page && !page.isClosed()) {
            await page.waitForTimeout(1200);
            capturaResultadoTienda = await tomarCapturaTienda(page, id, `resultado_${resultado.tipo.toLowerCase()}`).catch(() => null);
        }

        if (resultado.tipo === 'EXITO') {
            const info = await extraerDatosConfirmacionTienda(page, datos);

            const textoExito = 
                `🎉 <b>¡SU RECARGA FUE EXITOSA!</b> 🎉\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `📱 <b>Línea:</b> <code>${info.numero}</code>\n` +
                `📦 <b>Paquete:</b> ${info.nombrePaquete}\n` +
                `💲 <b>Monto:</b> $${info.monto} MXN\n` +
                `📅 <b>Fecha y hora:</b> ${info.fechaHora}\n` +
                `⏳ <b>Vigencia:</b> ${info.vigencia}\n` +
                `🧾 <b>Folio Telcel:</b> <code>${info.folioTelcel}</code>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `✨ <i>Gracias por su preferencia.</i>`;

            if (capturaResultadoTienda && fs.existsSync(capturaResultadoTienda)) {
                await ctx.replyWithPhoto(
                    { source: capturaResultadoTienda },
                    { caption: textoExito.slice(0, 1024), parse_mode: 'HTML' }
                ).catch(() => {});
            } else {
                await ctx.replyWithHTML(textoExito).catch(() => {});
            }
        } else if (resultado.tipo === 'RECHAZO_BANCARIO') {
            const textoRechazo =
                `❌ <b>PAGO RECHAZADO</b>
` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` +
                `📱 <b>Línea:</b> <code>${numero}</code>
` +
                `💲 <b>Monto:</b> $${monto} MXN

` +
                `💳 El portal mostró un rechazo bancario definitivo.`;

            if (capturaResultadoTienda && fs.existsSync(capturaResultadoTienda)) {
                await ctx.replyWithPhoto({ source: capturaResultadoTienda }, { caption: textoRechazo, parse_mode: 'HTML' }).catch(() => {});
            } else {
                await ctx.replyWithHTML(textoRechazo).catch(() => {});
            }
        } else if (resultado.tipo === 'FORMA_PAGO_NO_DISPONIBLE') {
            const textoNoDisponible =
                `⚠️ <b>FORMA DE PAGO NO DISPONIBLE</b>
` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` +
                `El portal mostró que la forma de pago seleccionada no está disponible.

` +
                `👉 <b>Intenta nuevamente o utiliza otro medio.</b>`;

            if (capturaResultadoTienda && fs.existsSync(capturaResultadoTienda)) {
                await ctx.replyWithPhoto({ source: capturaResultadoTienda }, { caption: textoNoDisponible, parse_mode: 'HTML' }).catch(() => {});
            } else {
                await ctx.replyWithHTML(textoNoDisponible).catch(() => {});
            }
        } else if (resultado.tipo === 'ERROR_CONEXION') {
            const textoConexion =
                `⚠️ <b>TELCEL.COM — ERROR DE CONEXIÓN AL PROCESAR EL PAGO</b>
` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` +
                `📱 <b>Línea:</b> <code>${numero}</code>
` +
                `💲 <b>Monto:</b> $${monto} MXN

` +
                `📄 <b>Mensaje del portal:</b>
` +
                `<i>“Se presentó un error de conexión al momento de procesar tu pago. Lamentamos el inconveniente, por favor espera unos minutos e intenta de nuevo.”</i>

` +
                `🛑 <b>Telcel interrumpió el flujo y no permitió continuar desde esa pantalla.</b>
` +
                `ℹ️ <b>Resultado:</b> No se obtuvo confirmación definitiva de pago aprobado o rechazado.
` +
                `🔎 <b>Antes de volver a intentar, verifica si la recarga o el cargo fueron aplicados.</b>`;

            if (capturaResultadoTienda && fs.existsSync(capturaResultadoTienda)) {
                await ctx.replyWithPhoto({ source: capturaResultadoTienda }, { caption: textoConexion.slice(0, 1024), parse_mode: 'HTML' }).catch(() => {});
            } else {
                await ctx.replyWithHTML(textoConexion).catch(() => {});
            }
        } else {
            await ctx.replyWithHTML(
                `⏳ <b>RECARGA EN PROCESO</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `El portal demoró en responder. Por favor revise el saldo de su línea o SMS de confirmación.`
            ).catch(() => {});
        }

    } catch (err) {
        logTelcelTienda(id, `❌ Error: ${err.message}`);

        if (err && err.message === 'NUMERO_INVALIDO') {
            logTelcelTienda(id, `⚠️ NUMERO_INVALIDO detectado`);
            logTelcelTienda(id, `🧹 Intento anterior cerrado`);
            logTelcelTienda(id, `🔄 Esperando nuevo número`);

            const s = sesiones.get(id) || datos;
            s.paso = 'numero';
            s.numero = null;
            sesiones.set(id, s);

            await ctx.replyWithHTML(
                `❌ <b>El número ingresado no es válido o no fue reconocido.</b>\n\n` +
                `📱 <b>Ingresa nuevamente el número de 10 dígitos:</b>`
            ).catch(() => {});
            return;
        }

        let capturaError = null;
        let urlActual = 'desconocida';
        let titulo = 'desconocido';
        let textoResumen = '';

        if (page && !page.isClosed()) {
            urlActual = page.url();
            titulo = await page.title().catch(() => 'desconocido');
            textoResumen = (await page.locator('body').innerText({ timeout: 1500 }).catch(() => '')).slice(0, 300);
            capturaError = await tomarCapturaTienda(page, id, 'error').catch(() => null);
        }

        console.error(`[Telcel.com Diagnóstico Falla] Usuario ${id}:`);
        console.error(`   - URL: ${urlActual}`);
        console.error(`   - Título: ${titulo}`);
        console.error(`   - Selector / Causa: ${err.message}`);
        console.error(`   - Texto visible: ${textoResumen.replace(/\n+/g, ' ')}`);

        if (capturaError && fs.existsSync(capturaError)) {
            await ctx.replyWithPhoto(
                { source: capturaError },
                {
                    caption:
                        `❌ <b>TELCEL.COM — ERROR EN PROCESO</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `⚠️ <b>Detalle:</b> <code>${err.message}</code>\n\n` +
                        `<i>Escribe /start para reiniciar el menú.</i>`,
                    parse_mode: 'HTML'
                }
            ).catch(() => {});

            setTimeout(() => { fs.unlink(capturaError, () => {}); }, 120000);
        } else {
            await ctx.replyWithHTML(
                `❌ <b>TELCEL.COM — ERROR</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `⚠️ <b>Detalle:</b> <code>${err.message}</code>\n\n` +
                `<i>Escribe /start para reiniciar el menú.</i>`
            ).catch(() => {});
        }

    } finally {
        await cerrarNavegadorTienda(id);
        logTelcelTienda(id, `🧹 [Telcel.com] Navegador cerrado`);
        const s = sesiones.get(id);
        if (s && s.paso !== 'numero') {
            sesiones.delete(id);
        }
    }
}


// ==============================================================================
// 🤖 7. INTERFAZ OFICIAL "BOT LEÓN" (BOTONES TEMPORALES Y AUTO-LIMPIEZA)
// ==============================================================================
async function mostrarMenuInicio(ctx, esReinicio = false) {
    const id = ctx.chat?.id || ctx.from?.id;
    await cerrarSesionNavegador(id);
    await cerrarNavegadorBait(id);
    if (cerrarNavegadorTienda) await cerrarNavegadorTienda(id).catch(() => {});
    await limpiarMensajesTemporales(ctx, id);
    sesiones.delete(id);

    const textoMenu = 
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🦁 <b>BOT LEÓN</b> 🤖\n` +
        `👋 ¡BIENVENIDO! Recargas veloces • 100% Seguras • Sin errores 📱💳\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🎯 <b>SELECCIONA COMPAÑÍA O SERVICIO</b>\n` +
        `▫️ 🟢 <b>TELCEL PAY</b>\n` +
        `▫️ 🔵 <b>BAIT</b>\n` +
        `▫️ 🟣 <b>RECARGAS TELCEL.COM</b>\n\n` +
        `▫️🔄 <b>REINICIAR</b>   ▫️🛑 <b>CANCELAR</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💲 <b>MONTOS VÁLIDOS</b>\n` +
        `✅ <b>TELCEL PAY:</b> ▫️$200 ▫️$300 ▫️$500\n` +
        `✅ <b>BAIT:</b> ▫️$200 ▫️$230 ▫️$300\n` +
        `✅ <b>TELCEL.COM:</b> ▫️$200 ▫️$300 ▫️$500\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 <b>CÓMO FUNCIONA</b>\n` +
        `▫️ 1️⃣ Elige servicio\n` +
        `▫️ 2️⃣ Selecciona monto\n` +
        `▫️ 3️⃣ Número: 10 dígitos\n` +
        `▫️ 4️⃣ Tarjeta: 16DÍGITOS | MM | AA | CVV\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🧹 <b>LIMPIEZA AUTOMÁTICA</b>\n` +
        `▫️ Cada paso borra el anterior → Sin trabas • Sin confusiones\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👉 <b>TOCA UNA OPCIÓN PARA EMPEZAR:</b>`;

    const filasTeclado = [
        [
            Markup.button.callback('🟢 TELCEL PAY', 'btn_telcel'),
            Markup.button.callback('🔵 BAIT', 'btn_bait')
        ],
        [
            Markup.button.callback('🟣 RECARGAS TELCEL.COM', 'btn_telcel_tienda')
        ],
        [
            Markup.button.callback('🔄 REINICIAR', 'btn_reiniciar'),
            Markup.button.callback('🛑 CANCELAR', 'btn_cancelar')
        ]
    ];

    // Botones exclusivos de gestión para el Administrador
    if (String(id) === ADMIN_ID_STR) {
        filasTeclado.push([
            Markup.button.callback('➕ AGREGAR USUARIO', 'btn_admin_add_user'),
            Markup.button.callback('👥 USUARIOS', 'btn_admin_ver_users')
        ]);
    }

    const tecladoMenu = Markup.inlineKeyboard(filasTeclado);

    const msg = await ctx.reply(textoMenu, { parse_mode: 'HTML', ...tecladoMenu });
    if (msg && msg.message_id) {
        registrarMensajeTemporal(id, msg.message_id);
    }
    return msg;
}

// 👮 COMANDOS DE ADMINISTRACIÓN PRIVADA (ADMIN: 8354262550)
bot.command(['adduser', 'add_user', 'permitir', 'autorizar'], async ctx => {
    const adminId = String(ctx.from?.id || '');
    if (adminId !== ADMIN_ID_STR) return;

    const nuevoId = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!nuevoId || !/^\d+$/.test(nuevoId)) {
        return ctx.reply('ℹ️ Uso: <code>/adduser &lt;id_telegram&gt;</code>', { parse_mode: 'HTML' });
    }

    autorizarUsuarioPersistente(nuevoId);
    console.log(`[Seguridad] Usuario ${nuevoId} agregado y guardado por Admin ${adminId}`);
    return ctx.reply(`✅ <b>Usuario Autorizado:</b> <code>${nuevoId}</code>`, { parse_mode: 'HTML' });
});

bot.command(['deluser', 'del_user', 'quitar', 'revocar'], async ctx => {
    const adminId = String(ctx.from?.id || '');
    if (adminId !== ADMIN_ID_STR) return;

    const idEliminar = ctx.message.text.split(/\s+/)[1]?.trim();
    if (!idEliminar || idEliminar === ADMIN_ID_STR) {
        return ctx.reply('⚠️ Especifica un ID válido (no puedes eliminar el ID principal).');
    }

    revocarUsuarioPersistente(idEliminar);
    console.log(`[Seguridad] Usuario ${idEliminar} eliminado y guardado por Admin ${adminId}`);
    return ctx.reply(`🗑️ <b>Usuario Revocado:</b> <code>${idEliminar}</code>`, { parse_mode: 'HTML' });
});

bot.command(['listusers', 'usuarios', 'lista_usuarios'], async ctx => {
    const adminId = String(ctx.from?.id || '');
    if (adminId !== ADMIN_ID_STR) return;

    const lista = Array.from(USUARIOS_AUTORIZADOS).map(u => `• <code>${u}</code> ${u === ADMIN_ID_STR ? '👑 (Principal)' : ''}`).join('\n');
    return ctx.reply(`👥 <b>Lista de Usuarios Autorizados:</b>\n\n${lista}`, { parse_mode: 'HTML' });
});

// 🛑 COMANDOS DE CONTROL
bot.command(['stop', 'cancelar', 'reset'], async ctx => {
    const id = ctx.chat?.id || ctx.from?.id;
    await cerrarSesionNavegador(id);
    await cerrarNavegadorBait(id);
    if (cerrarNavegadorTienda) await cerrarNavegadorTienda(id).catch(() => {});
    await limpiarMensajesTemporales(ctx, id);
    sesiones.delete(id);

    const msg = await ctx.reply(
        `🛑 <b>OPERACIÓN CANCELADA (RESET COMPLETO)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Todo limpio. Para comenzar de nuevo toca el botón:`,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('🦁 IR AL MENÚ PRINCIPAL', 'btn_reiniciar')]])
        }
    );
    if (msg && msg.message_id) registrarMensajeTemporal(id, msg.message_id);
});

bot.command(['start', 'inicio', 'menu', 'ayuda'], async ctx => {
    return mostrarMenuCategoriasPrincipal(ctx);
});

bot.command('telcel', async ctx => {
    return iniciarCompania(ctx, 'Telcel');
});

bot.command(['tienda', 'tiendatelcel', 'telcelcom', 'recargas'], async ctx => {
    return iniciarCompania(ctx, 'Telcel.com');
});

bot.command('bait', async ctx => {
    return iniciarCompania(ctx, 'Bait');
});

// 🧪 COMANDO DIRECTO TELCEL ($10) — FLUJO COMPLETO HASTA RESULTADO FINAL
bot.command('prueba10', async ctx => {
    const id = ctx.chat?.id || ctx.from?.id;
    await cerrarSesionNavegador(id);
    await cerrarNavegadorBait(id);
    if (cerrarNavegadorTienda) await cerrarNavegadorTienda(id).catch(() => {});
    await limpiarMensajesTemporales(ctx, id);

    sesiones.set(id, { 
        tipo: 'Telcel', 
        modo: 'telcel', 
        monto: 10, 
        paso: 'numero', 
        intentosTarjeta: 0 
    });

    logTelcel(id, `🚀 Iniciando flujo completo Telcel ($10) por /prueba10`);

    const textoPaso2 = 
        `🟢 <b>TELCEL — PASO 2 DE 3</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `✅ <b>Monto seleccionado:</b> $10 MXN\n\n` +
        `📱 <b>ESCRIBE EL NÚMERO CELULAR (10 DÍGITOS):</b>\n` +
        `▫️ Ejemplo: <code>5512345678</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `✍️ <b>Envía tu mensaje con el número:</b> `;

    return enviarLimpio(ctx, textoPaso2, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 REINICIAR', 'btn_reiniciar'), Markup.button.callback('🛑 CANCELAR', 'btn_cancelar')]
    ]));
});

// CALLBACKS DE BOTONES DEL MENÚ PRINCIPAL
bot.action('btn_telcel', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    return iniciarCompania(ctx, 'Telcel');
});

bot.action('btn_telcel_tienda', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    return iniciarCompania(ctx, 'Telcel.com');
});

bot.action('btn_bait', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    return iniciarCompania(ctx, 'Bait');
});

bot.action('btn_reiniciar', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    return mostrarMenuInicio(ctx, true);
});

bot.action('btn_reintentar_bait', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    const id = ctx.chat?.id || ctx.from?.id;
    const s = sesiones.get(id);
    if (!s || !s.numero) {
        return mostrarMenuInicio(ctx);
    }
    const datos = {
        ...s,
        numero: s.numero,
        monto: s.monto || 300
    };
    return flujoBait(ctx, id, datos);
});

bot.action('btn_cancelar', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    const id = ctx.chat?.id || ctx.from?.id;
    await cerrarSesionNavegador(id);
    await cerrarNavegadorBait(id);
    if (cerrarNavegadorTienda) await cerrarNavegadorTienda(id).catch(() => {});
    await limpiarMensajesTemporales(ctx, id);
    sesiones.delete(id);

    const msg = await ctx.reply(
        `🛑 <b>OPERACIÓN CANCELADA</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👉 <b>Toca el botón para abrir el menú:</b> `,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('🦁 IR AL MENÚ PRINCIPAL', 'btn_reiniciar')]])
        }
    );
    if (msg && msg.message_id) registrarMensajeTemporal(id, msg.message_id);
});

// PASO 1: SELECCIÓN DE MONTO CON BOTONES EXACTOS
async function iniciarCompania(ctx, compania) {
    const id = ctx.chat?.id || ctx.from?.id;
    if (compania === 'Bait') {
        cerrarNavegadorBait(id);
    } else if (compania === 'Telcel.com' || compania === 'Telcel Tienda') {
        if (cerrarNavegadorTienda) cerrarNavegadorTienda(id);
    } else {
        cerrarSesionNavegador(id);
    }

    const modo = (compania === 'Telcel.com' || compania === 'Telcel Tienda') ? 'telcel_tienda' : compania.toLowerCase();

    sesiones.set(id, { 
        tipo: compania, 
        modo: modo, 
        paso: 'monto', 
        intentosTarjeta: 0 
    });

    let icono = '🟢';
    if (compania === 'Bait') icono = '🔵';
    if (compania === 'Telcel.com' || compania === 'Telcel Tienda') icono = '🟣';

    const botonesMonto = compania === 'Bait'
        ? [
            [
                Markup.button.callback('▫️ $200 ▫️', 'monto_200'),
                Markup.button.callback('▫️ $230 ▫️', 'monto_230'),
                Markup.button.callback('▫️ $300 ▫️', 'monto_300')
            ],
            [
                Markup.button.callback('🔄 REINICIAR', 'btn_reiniciar'),
                Markup.button.callback('🛑 CANCELAR', 'btn_cancelar')
            ]
        ]
        : [
            [
                Markup.button.callback('▫️ $200 ▫️', 'monto_200'),
                Markup.button.callback('▫️ $300 ▫️', 'monto_300'),
                Markup.button.callback('▫️ $500 ▫️', 'monto_500')
            ],
            [
                Markup.button.callback('🔄 REINICIAR', 'btn_reiniciar'),
                Markup.button.callback('🛑 CANCELAR', 'btn_cancelar')
            ]
        ];

    const textoPaso1 = 
        `${icono} <b>${compania.toUpperCase()} — PASO 1 DE 3</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💲 <b>SELECCIONA EL MONTO EXACTO A RECARGAR:</b>\n\n` +
        `👉 <b>Toca un botón de monto:</b> `;

    return enviarLimpio(ctx, textoPaso1, Markup.inlineKeyboard(botonesMonto));
}

// CALLBACKS DE SELECCIÓN DE MONTO
bot.action(['monto_200', 'monto_230', 'monto_300', 'monto_500'], async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    const id = ctx.chat?.id || ctx.from?.id;
    const data = ctx.match[0];
    const valorMonto = parseInt(data.replace('monto_', ''), 10);

    let s = sesiones.get(id);
    if (!s) {
        s = { tipo: 'Telcel.com', modo: 'telcel_tienda', paso: 'monto', intentosTarjeta: 0 };
    }

    s.monto = valorMonto;
    s.paso = 'numero';
    s.numero = null;
    s.tarjeta = null;
    sesiones.set(id, s);

    const compania = s.tipo || 'Telcel.com';
    let icono = '🟢';
    if (compania === 'Bait') icono = '🔵';
    if (compania === 'Telcel.com' || compania === 'Telcel Tienda' || s.modo === 'telcel_tienda') icono = '🟣';

    const textoPaso2 = 
        `${icono} <b>${compania.toUpperCase()} — PASO 2 DE 3</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `✅ <b>Monto seleccionado:</b> $${valorMonto} MXN\n\n` +
        `📱 <b>ESCRIBE EL NÚMERO CELULAR (10 DÍGITOS):</b>\n` +
        `▫️ Ejemplo: <code>5512345678</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `✍️ <b>Envía tu mensaje con el número:</b> `;

    return enviarLimpio(ctx, textoPaso2, Markup.inlineKeyboard([
        [Markup.button.callback('🔄 REINICIAR', 'btn_reiniciar'), Markup.button.callback('🛑 CANCELAR', 'btn_cancelar')]
    ]));
});

// CALLBACKS DE ADMINISTRACIÓN DE USUARIOS (PANEL DIRECTO)
bot.action('btn_admin_add_user', async ctx => {
    const id = ctx.chat?.id || ctx.from?.id;
    if (String(id) !== ADMIN_ID_STR) return ctx.answerCbQuery();
    await ctx.answerCbQuery().catch(() => {});
    sesiones.set(id, { paso: 'esperando_id_usuario' });

    return enviarLimpio(ctx,
        `➕ <b>AGREGAR USUARIO AUTORIZADO</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Envía únicamente el <b>ID de Telegram</b> del usuario que deseas autorizar.\n\n` +
        `<i>(Ejemplo: <code>123456789</code>)</i>`,
        Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ VOLVER AL MENÚ', 'btn_reiniciar')]
        ])
    );
});

bot.action('btn_admin_ver_users', async ctx => {
    const id = ctx.chat?.id || ctx.from?.id;
    if (String(id) !== ADMIN_ID_STR) return ctx.answerCbQuery();
    await ctx.answerCbQuery().catch(() => {});

    const botonesUsuarios = [];
    for (const u of USUARIOS_AUTORIZADOS) {
        if (u === ADMIN_ID_STR) {
            botonesUsuarios.push([Markup.button.callback(`👑 ${u} (Tú / Principal)`, 'btn_noop')]);
        } else {
            botonesUsuarios.push([Markup.button.callback(`❌ Eliminar ${u}`, `btn_del_user_${u}`)]);
        }
    }

    botonesUsuarios.push([
        Markup.button.callback('➕ AGREGAR USUARIO', 'btn_admin_add_user'),
        Markup.button.callback('🦁 VOLVER AL MENÚ', 'btn_reiniciar')
    ]);

    return enviarLimpio(ctx,
        `👥 <b>USUARIOS AUTORIZADOS</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Total de usuarios con acceso: <b>${USUARIOS_AUTORIZADOS.size}</b>\n\n` +
        `<i>Toca un botón con ❌ para revocar el acceso a un usuario:</i>`,
        Markup.inlineKeyboard(botonesUsuarios)
    );
});

bot.action('btn_noop', async ctx => {
    await ctx.answerCbQuery('👑 Este es tu usuario principal.').catch(() => {});
});

bot.action(/^btn_del_user_(\d+)$/, async ctx => {
    const id = ctx.chat?.id || ctx.from?.id;
    if (String(id) !== ADMIN_ID_STR) return ctx.answerCbQuery();
    const idEliminar = ctx.match[1];
    if (idEliminar !== ADMIN_ID_STR) {
        revocarUsuarioPersistente(idEliminar);
        console.log(`[Seguridad] Usuario ${idEliminar} eliminado y guardado por Admin ${id}`);
        await ctx.answerCbQuery(`✅ Usuario ${idEliminar} eliminado.`).catch(() => {});
    }

    // Actualizar vista de usuarios
    const botonesUsuarios = [];
    for (const u of USUARIOS_AUTORIZADOS) {
        if (u === ADMIN_ID_STR) {
            botonesUsuarios.push([Markup.button.callback(`👑 ${u} (Tú / Principal)`, 'btn_noop')]);
        } else {
            botonesUsuarios.push([Markup.button.callback(`❌ Eliminar ${u}`, `btn_del_user_${u}`)]);
        }
    }
    botonesUsuarios.push([
        Markup.button.callback('➕ AGREGAR USUARIO', 'btn_admin_add_user'),
        Markup.button.callback('🦁 VOLVER AL MENÚ', 'btn_reiniciar')
    ]);

    return enviarLimpio(ctx,
        `👥 <b>USUARIOS AUTORIZADOS</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Total de usuarios con acceso: <b>${USUARIOS_AUTORIZADOS.size}</b>\n\n` +
        `<i>Toca un botón con ❌ para revocar el acceso a un usuario:</i>`,
        Markup.inlineKeyboard(botonesUsuarios)
    );
});

// ==============================================================================
// 📨 8. ROUTER DE MENSAJES Y PASOS POR TEXTO (INTERFAZ LIMPIA Y FLUIDA)
// ==============================================================================
bot.on('text', async (ctx, next) => {
    const id = ctx.chat?.id || ctx.from?.id;
    const txt = ctx.message.text.trim();

    if (txt.startsWith('/')) return next();

    let s = sesiones.get(id);

    // 0. GESTIÓN DIRECTA DE AGREGAR USUARIO POR BOTÓN
    if (s && s.paso === 'esperando_id_usuario') {
        if (/^\d{5,15}$/.test(txt)) {
            autorizarUsuarioPersistente(txt);
            console.log(`[Seguridad] Usuario ${txt} autorizado y guardado por Admin ${id}`);
            sesiones.delete(id);
            return enviarLimpio(ctx,
                `✅ <b>USUARIO AUTORIZADO CON ÉXITO</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `El ID <code>${txt}</code> ya tiene acceso completo para usar el bot.\n\n` +
                `👉 <b>¿Qué deseas hacer ahora?</b>`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('➕ AGREGAR OTRO USUARIO', 'btn_admin_add_user')],
                    [Markup.button.callback('👥 VER TODOS LOS USUARIOS', 'btn_admin_ver_users')],
                    [Markup.button.callback('🦁 IR AL MENÚ PRINCIPAL', 'btn_reiniciar')]
                ])
            );
        } else {
            return enviarLimpio(ctx,
                `⚠️ <b>ID INVÁLIDO</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `El ID de Telegram debe contener únicamente números (ejemplo: <code>123456789</code>).\n\n` +
                `Por favor escribe un ID numérico válido:`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('⬅️ CANCELAR / VOLVER AL MENÚ', 'btn_reiniciar')]
                ])
            );
        }
    }

    // A. DETECCIÓN DE COMPAÑÍA EN TEXTO
    if (/^(telcel|bait|tienda|telcel\.com|recargas)$/i.test(txt)) {
        let comp = 'Telcel';
        if (txt.toLowerCase().includes('bait')) comp = 'Bait';
        if (txt.toLowerCase().includes('tienda') || txt.toLowerCase().includes('telcel.com') || txt.toLowerCase().includes('recargas')) comp = 'Telcel.com';
        return iniciarCompania(ctx, comp);
    }

    if (!s) {
        return mostrarMenuInicio(ctx);
    }

    // B. DETECCIÓN DE MONTO EN TEXTO
    const matchMonto = txt.match(/^\$?(\d{2,3})$/);
    if (matchMonto && [200, 230, 300, 500].includes(parseInt(matchMonto[1], 10))) {
        const monto = parseInt(matchMonto[1], 10);
        
        // Validación de montos exactos por compañía
        if ((s.tipo === 'Telcel' || s.tipo === 'Telcel.com') && ![200, 300, 500].includes(monto)) {
            return enviarLimpio(ctx,
                `⚠️ <b>MONTO INVÁLIDO PARA TELCEL</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Los montos exactos para Telcel son: ▫️$200 ▫️$300 ▫️$500\n\n` +
                `👉 <b>Selecciona un monto válido:</b> `,
                Markup.inlineKeyboard([
                    [Markup.button.callback('▫️ $200 ▫️', 'monto_200'), Markup.button.callback('▫️ $300 ▫️', 'monto_300'), Markup.button.callback('▫️ $500 ▫️', 'monto_500')],
                    [Markup.button.callback('🔄 REINICIAR', 'btn_reiniciar')]
                ])
            );
        }

        if (s.tipo === 'Bait' && ![200, 230, 300].includes(monto)) {
            return enviarLimpio(ctx,
                `⚠️ <b>MONTO INVÁLIDO PARA BAIT</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Los montos exactos para Bait son: ▫️$200 ▫️$230 ▫️$300\n\n` +
                `👉 <b>Selecciona un monto válido:</b> `,
                Markup.inlineKeyboard([
                    [Markup.button.callback('▫️ $200 ▫️', 'monto_200'), Markup.button.callback('▫️ $230 ▫️', 'monto_230'), Markup.button.callback('▫️ $300 ▫️', 'monto_300')],
                    [Markup.button.callback('🔄 REINICIAR', 'btn_reiniciar')]
                ])
            );
        }

        s.monto = monto;
        s.paso = 'numero';
        s.numero = null;
        s.tarjeta = null;
        s.intentosTarjeta = 0;
        sesiones.set(id, s);

        const compania = s.tipo || 'Telcel';
        let icono = '🟢';
        if (compania === 'Bait') icono = '🔵';
        if (compania === 'Telcel.com' || compania === 'Telcel Tienda' || s.modo === 'telcel_tienda') icono = '🟣';

        return enviarLimpio(ctx,
            `${icono} <b>${compania.toUpperCase()} — PASO 2 DE 3</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `✅ <b>Monto seleccionado:</b> $${monto} MXN\n\n` +
            `📱 <b>ESCRIBE EL NÚMERO CELULAR (10 DÍGITOS):</b>\n` +
            `▫️ Ejemplo: <code>5512345678</code>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `✍️ <b>Envía tu mensaje con el número:</b> `,
            Markup.inlineKeyboard([
                [Markup.button.callback('🔄 REINICIAR', 'btn_reiniciar'), Markup.button.callback('🛑 CANCELAR', 'btn_cancelar')]
            ])
        );
    }

    // C. DETECCIÓN DE NÚMERO CELULAR (VALIDACIÓN LOCAL ESTRICTA: /^\d{10}$/)
    if (s.paso === 'numero' || (/^\d+$/.test(txt) && !s.numero && !String(s.paso || '').startsWith('monto'))) {
        if (!/^\d{10}$/.test(txt)) {
            return enviarLimpio(ctx,
                `❌ <b>El número debe contener exactamente 10 dígitos.</b>\n\n` +
                `📱 <b>Intenta nuevamente:</b>`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 REINICIAR', 'btn_reiniciar'), Markup.button.callback('🛑 CANCELAR', 'btn_cancelar')]
                ])
            );
        }

        s.numero = txt;
        sesiones.set(id, s);

        let nombreFlujo = 'TELCEL';
        if (s.modo === 'bait' || s.tipo === 'Bait') {
            nombreFlujo = 'BAIT';
        } else if (s.modo === 'telcel_tienda' || s.tipo === 'Telcel.com' || s.tipo === 'Telcel Tienda') {
            nombreFlujo = 'TELCEL.COM';
        }

        console.log(`📱 [Usuario ${id}] Nuevo número recibido: ${txt}`);
        console.log(`🔄 [Usuario ${id}] Reiniciando flujo [${nombreFlujo}]`);

        // Si ya cuenta con tarjeta cargada (reintento automático tras número inválido):
        if (s.tarjeta || s.cc) {
            s.paso = 'ejecutando';
            sesiones.set(id, s);

            if (nombreFlujo === 'TELCEL.COM') {
                return flujoTelcelTienda(ctx, id, s).catch(err => {
                    console.error(`[Telcel.com Usuario ${id}] Error:`, err.message || err);
                });
            } else if (nombreFlujo === 'BAIT') {
                return flujoBait(ctx, id, s).catch(err => {
                    console.error(`[Bait Usuario ${id}] Error:`, err.message || err);
                });
            } else {
                return flujoTelcelIndependiente(ctx, id, s).catch(err => {
                    console.error(`[Telcel Usuario ${id}] Error:`, err.message || err);
                });
            }
        }

        // Primer ingreso normal: solicita los datos de tarjeta
        s.paso = 'tarjeta';
        sesiones.set(id, s);

        const compania = s.tipo || 'Telcel';
        let icono = '🟢';
        if (compania === 'Bait') icono = '🔵';
        if (compania === 'Telcel.com' || compania === 'Telcel Tienda' || s.modo === 'telcel_tienda') icono = '🟣';

        return enviarLimpio(ctx,
            `${icono} <b>${compania.toUpperCase()} — PASO 3 DE 3</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `✅ <b>Número confirmado:</b> <code>${s.numero}</code>\n` +
            `💲 <b>Monto:</b> $${s.monto || 200} MXN\n\n` +
            `💳 <b>INGRESA TU TARJETA PARA PROCESAR EL PAGO:</b>\n` +
            `▫️ Formato: <code>16DÍGITOS|MM|AA|CVV</code>\n` +
            `▫️ Ejemplo: <code>4123567890123456|10|28|123</code>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `✍️ <b>Envía los datos de tu tarjeta para procesar:</b> `,
            Markup.inlineKeyboard([
                [Markup.button.callback('🔄 REINICIAR', 'btn_reiniciar'), Markup.button.callback('🛑 CANCELAR', 'btn_cancelar')]
            ])
        );
    }

    // D. DETECCIÓN Y PARSEO INTELIGENTE DE TARJETA
    if (s.paso === 'tarjeta' || txt.includes('|') || txt.includes('/') || txt.split(/\s+/).length >= 3) {
        const resultadoParseo = parsearDatosTarjeta(txt);

        if (!resultadoParseo.valido) {
            return enviarLimpio(ctx,
                `⚠️ <b>DATOS DE TARJETA INCORRECTOS</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `Verifica que cumpla con:\n` +
                `▫️ <b>Tarjeta:</b> 15 o 16 dígitos\n` +
                `▫️ <b>Mes:</b> 2 dígitos (01 al 12)\n` +
                `▫️ <b>Año:</b> 2 dígitos (ej: <b>28</b>) o 4 dígitos (ej: <b>2028</b>)\n` +
                `▫️ <b>CVV:</b> 3 o 4 dígitos\n\n` +
                `▫️ <b>Ejemplo:</b> <code>4123567890123456|10|28|123</code>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `✍️ <b>Escribe los datos de tu tarjeta nuevamente:</b> `,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 REINICIAR', 'btn_reiniciar')]
                ])
            );
        }

        const { tarjeta, mes, anio, anioCompleto, cvv, ult4 } = resultadoParseo;
        const datosPersona = generarNombreCompleto();
        const dirValida = generarDireccionValida();
        const cp_auto = dirValida.cp;
        const tel_auto = generarTelefonoUnico();
        const correo_auto = generarCorreoUnico(datosPersona);

        s.tarjeta = tarjeta;
        s.cc = tarjeta;
        s.mes = mes;
        s.anio = anio;
        s.anioCompleto = anioCompleto;
        s.cvv = cvv;
        s.ult4 = ult4;
        s.nombre = datosPersona;
        s.direccion_valida = dirValida;
        s.cp_auto = cp_auto;
        s.tel_auto = tel_auto;
        s.correo_auto = correo_auto;

        if (s.modo === 'telcel_tienda' || s.tipo === 'Telcel.com' || s.tipo === 'Telcel Tienda') {
            s.paso = 'ejecutando';
            flujoTelcelTienda(ctx, id, s).catch(err => {
                console.error(`[Telcel.com Usuario ${id}] Error:`, err.message || err);
            });
        } else if (s.modo === 'bait' || s.tipo === 'Bait') {
            s.paso = 'ejecutando';
            flujoBait(ctx, id, s).catch(err => {
                console.error(`[Bait Usuario ${id}] Error:`, err.message || err);
            });
        } else {
            s.paso = 'ejecutando';
            flujoTelcelIndependiente(ctx, id, s).catch(err => {
                console.error(`[Telcel Usuario ${id}] Error:`, err.message || err);
            });
        }
        return;
    }

    return mostrarMenuInicio(ctx);
});


// ==============================================================================
// 🚀 9. SERVIDOR HTTP Y MANTENEDOR ANTI-APAGADO CON RECUPERACIÓN DE PUERTO
// ==============================================================================
const servidor = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('🦁 BOT LEÓN ACTIVO');
});

// Manejo inteligente de EADDRINUSE para evitar bloqueos de puerto en local
servidor.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`⚠️ Puerto ${PUERTO} ocupado. Iniciando en puerto dinámico libre...`);
        servidor.listen(0, '0.0.0.0', () => {
            const nuevoP = servidor.address().port;
            console.log(`✅ Servidor HTTP iniciado en puerto libre alternativo: ${nuevoP}`);
        });
    } else {
        console.error('⚠️ Error en servidor HTTP:', err.message || err);
    }
});

process.once('SIGINT', async () => {
    try { await bot.stop('SIGINT'); } catch(e) {}
    for (const [id] of navegadoresActivos) {
        await cerrarSesionNavegador(id);
    }
    await cerrarNavegadorBait();
    await cerrarNavegadorTienda();
    servidor.close(() => process.exit(0));
});

process.once('SIGTERM', async () => {
    try { await bot.stop('SIGTERM'); } catch(e) {}
    for (const [id] of navegadoresActivos) {
        await cerrarSesionNavegador(id);
    }
    await cerrarNavegadorBait();
    await cerrarNavegadorTienda();
    servidor.close(() => process.exit(0));
});

function iniciarServidorYBot() {
    servidor.listen(PUERTO, '0.0.0.0', () => {
        console.log(`🦁 BOT LEÓN INICIADO EN PUERTO: ${PUERTO}`);
    });

    verificarEntornoPlaywright();
    smokeTestPlaywright();

    console.log("⏳ Conectando BOT LEÓN a Telegram...");

    const INTERVALO_PING_MS = 8 * 60 * 1000;

    setInterval(() => {
        try {
            const clienteHttp = RENDER_EXTERNAL_URL.startsWith('https') ? https : http;
            clienteHttp.get(RENDER_EXTERNAL_URL, (res) => {
                console.log(`[KeepAlive] 💓 Ping a ${RENDER_EXTERNAL_URL} - Status: ${res.statusCode}`);
            }).on('error', (err) => {
                console.log(`[KeepAlive] ⚠️ Ping warning: ${err.message}`);
            });
        } catch (e) {
            console.log(`[KeepAlive] ⚠️ Error ping: ${e.message}`);
        }
    }, INTERVALO_PING_MS);

    async function configurarComandosTelegram() {
        const comandosNormales = [
            { command: 'start', description: 'Abrir menú principal' },
            { command: 'menu', description: 'Abrir menú principal' },
            { command: 'cancelar', description: 'Cancelar operación actual' }
        ];

        const comandosAdmin = [
            ...comandosNormales,
            { command: 'adduser', description: 'Agregar usuario autorizado' },
            { command: 'deluser', description: 'Eliminar usuario autorizado' },
            { command: 'listusers', description: 'Ver usuarios autorizados' }
        ];

        try {
            // Usuarios normales solo ven comandos normales.
            await bot.telegram.setMyCommands(comandosNormales, {
                scope: { type: 'default' }
            });

            // En tu chat privado aparecen además los comandos administrativos.
            await bot.telegram.setMyCommands(comandosAdmin, {
                scope: { type: 'chat', chat_id: ADMIN_ID }
            });

            console.log('✅ [ADMIN] Comandos privados configurados para el administrador.');
        } catch (error) {
            console.warn('⚠️ [ADMIN] No se pudieron configurar los comandos visibles:', error.message || error);
        }
    }

    async function iniciarTelegramBot() {
        try {
            await configurarComandosTelegram();
            await bot.launch({
                dropPendingUpdates: true,
                polling: {
                    timeout: 20,
                    limit: 100,
                    autoStart: true
                }
            });
            console.log("🦁 LISTO: BOT LEÓN CONECTADO EXITOSAMENTE A TELEGRAM");
        } catch (err) {
            if (err.message && (err.message.includes('409') || err.message.includes('Conflict'))) {
                console.log("⚠️ Conflicto 409 detectado (otra instancia activa cerrándose). Reintentando en 6s...");
                setTimeout(iniciarTelegramBot, 6000);
            } else {
                console.error("❌ ERROR BOT LEÓN:", err.message || err);
            }
        }
    }
    iniciarTelegramBot();
}

// ==============================================================================
// 🎬 STREAMING / NETFLIX
// ==============================================================================

// Estado Netflix aislado del sistema de recargas
const sesionesNetflixStreaming = new Map();

const URL_NETFLIX_STREAMING =
    process.env.URL_NETFLIX ||
    'https://www.netflix.com/mx/';


// ------------------------------------------------------------------------------
// GENERADORES NETFLIX
// ------------------------------------------------------------------------------

function netflixGenerarCorreo() {
    const nombresNetflix = [
        'carlos', 'maria', 'jorge', 'sofia',
        'daniel', 'ana', 'miguel', 'valeria'
    ];

    const dominiosNetflix = [
        'gmail.com',
        'outlook.com',
        'hotmail.com'
    ];

    const nombre =
        nombresNetflix[
            Math.floor(Math.random() * nombresNetflix.length)
        ];

    const numero =
        Date.now().toString().slice(-6);

    const dominio =
        dominiosNetflix[
            Math.floor(Math.random() * dominiosNetflix.length)
        ];

    return `${nombre}${numero}@${dominio}`;
}


function netflixGenerarPassword() {
    const caracteres =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*';

    let resultado = '';

    for (let i = 0; i < 12; i++) {
        resultado += caracteres[
            Math.floor(Math.random() * caracteres.length)
        ];
    }

    return resultado;
}


// ------------------------------------------------------------------------------
// MENÚ PRINCIPAL NUEVO
// RECARGAS / STREAMING
// ------------------------------------------------------------------------------

async function mostrarMenuCategoriasPrincipal(ctx) {

    const id = ctx.chat?.id || ctx.from?.id;

    await limpiarMensajesTemporales(ctx, id).catch(() => {});

    const texto =
        `🦁 <b>BOT LEÓN</b> 🤖\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📂 <b>SELECCIONA UNA CATEGORÍA</b>\n\n` +
        `💳 <b>RECARGAS</b>\n` +
        `🎬 <b>STREAMING</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👉 <b>Toca una opción:</b>`;

    const teclado = Markup.inlineKeyboard([
        [
            Markup.button.callback(
                '💳 RECARGAS',
                'menu_recargas_categoria'
            )
        ],
        [
            Markup.button.callback(
                '🎬 STREAMING',
                'menu_streaming_categoria'
            )
        ]
    ]);

    return enviarLimpio(
        ctx,
        texto,
        teclado
    );
}


// ------------------------------------------------------------------------------
// 💳 CARPETA RECARGAS
// USA TUS CALLBACKS ORIGINALES
// ------------------------------------------------------------------------------

bot.action(
    'menu_recargas_categoria',
    async ctx => {

        await ctx.answerCbQuery().catch(() => {});

        const texto =
            `💳 <b>RECARGAS</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `Selecciona el servicio:\n\n` +
            `🟢 Telcel Pay\n` +
            `🔵 BAIT\n` +
            `🟣 Recargas Telcel.com`;

        return ctx.editMessageText(
            texto,
            {
                parse_mode: 'HTML',

                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback(
                            '🟢 TELCEL PAY',
                            'btn_telcel'
                        ),

                        Markup.button.callback(
                            '🔵 BAIT',
                            'btn_bait'
                        )
                    ],

                    [
                        Markup.button.callback(
                            '🟣 RECARGAS TELCEL.COM',
                            'btn_telcel_tienda'
                        )
                    ],

                    [
                        Markup.button.callback(
                            '⬅️ ATRÁS',
                            'menu_principal_categoria'
                        )
                    ]
                ])
            }
        ).catch(() => mostrarMenuCategoriasPrincipal(ctx));
    }
);


// ------------------------------------------------------------------------------
// 🎬 CARPETA STREAMING
// ------------------------------------------------------------------------------

bot.action(
    'menu_streaming_categoria',
    async ctx => {

        await ctx.answerCbQuery().catch(() => {});

        const texto =
            `🎬 <b>STREAMING</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `Selecciona el servicio:`;

        return ctx.editMessageText(
            texto,
            {
                parse_mode: 'HTML',

                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback(
                            '🎬 NETFLIX',
                            'streaming_netflix'
                        )
                    ],

                    [
                        Markup.button.callback(
                            '⬅️ ATRÁS',
                            'menu_principal_categoria'
                        )
                    ]
                ])
            }
        ).catch(() => mostrarMenuCategoriasPrincipal(ctx));
    }
);


// ------------------------------------------------------------------------------
// VOLVER AL MENÚ PRINCIPAL
// ------------------------------------------------------------------------------

bot.action(
    'menu_principal_categoria',
    async ctx => {

        await ctx.answerCbQuery().catch(() => {});

        await ctx.deleteMessage()
            .catch(() => {});

        return mostrarMenuCategoriasPrincipal(ctx);
    }
);


// ------------------------------------------------------------------------------
// 🎬 NETFLIX
// ------------------------------------------------------------------------------

bot.action(
    'streaming_netflix',
    async ctx => {

        await ctx.answerCbQuery().catch(() => {});

        const id =
            ctx.chat?.id ||
            ctx.from?.id;

        sesionesNetflixStreaming.set(
            id,
            {
                paso: 'menu',
                modo: null,
                correo: null,
                pass: null
            }
        );

        const texto =
            `🎬 <b>NETFLIX — MÉXICO</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `Selecciona cómo quieres preparar los datos:\n\n` +
            `🎲 <b>AUTOMÁTICO</b>\n` +
            `El bot genera correo y contraseña.\n\n` +
            `✍️ <b>PERSONALIZADO</b>\n` +
            `Tú escribes correo y contraseña.`;

        return ctx.editMessageText(
            texto,
            {
                parse_mode: 'HTML',

                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback(
                            '🎲 AUTOMÁTICO',
                            'netflix_modo_auto'
                        )
                    ],

                    [
                        Markup.button.callback(
                            '✍️ PERSONALIZADO',
                            'netflix_modo_personal'
                        )
                    ],

                    [
                        Markup.button.callback(
                            '⬅️ STREAMING',
                            'menu_streaming_categoria'
                        )
                    ]
                ])
            }
        );
    }
);


// ------------------------------------------------------------------------------
// 🎲 NETFLIX AUTOMÁTICO
// ------------------------------------------------------------------------------

bot.action(
    'netflix_modo_auto',
    async ctx => {

        await ctx.answerCbQuery().catch(() => {});

        const id =
            ctx.chat?.id ||
            ctx.from?.id;

        const correo =
            netflixGenerarCorreo();

        const pass =
            netflixGenerarPassword();

        sesionesNetflixStreaming.set(
            id,
            {
                paso: 'listo',
                modo: 'automatico',
                correo,
                pass
            }
        );

        return ctx.editMessageText(
            `🎲 <b>NETFLIX — MODO AUTOMÁTICO</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📧 <b>Correo:</b>\n` +
            `<code>${correo}</code>\n\n` +
            `🔑 <b>Contraseña:</b>\n` +
            `<code>${pass}</code>\n\n` +
            `👉 Toca <b>ABRIR NETFLIX</b> para continuar.`,
            {
                parse_mode: 'HTML',

                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback(
                            '🚀 ABRIR NETFLIX',
                            'netflix_abrir'
                        )
                    ],

                    [
                        Markup.button.callback(
                            '⬅️ ATRÁS',
                            'streaming_netflix'
                        )
                    ]
                ])
            }
        );
    }
);


// ------------------------------------------------------------------------------
// ✍️ NETFLIX PERSONALIZADO
// ------------------------------------------------------------------------------

bot.action(
    'netflix_modo_personal',
    async ctx => {

        await ctx.answerCbQuery().catch(() => {});

        const id =
            ctx.chat?.id ||
            ctx.from?.id;

        sesionesNetflixStreaming.set(
            id,
            {
                paso: 'esperando_correo',
                modo: 'personalizado',
                correo: null,
                pass: null
            }
        );

        return ctx.editMessageText(
            `✍️ <b>NETFLIX — PERSONALIZADO</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📧 Escribe el <b>correo electrónico</b> ` +
            `que deseas utilizar.`,
            {
                parse_mode: 'HTML'
            }
        );
    }
);


// ------------------------------------------------------------------------------
// 📨 CAPTURAR CORREO/PASSWORD PERSONALIZADO
//
// IMPORTANTE:
// Este middleware se ejecuta solamente cuando existe una sesión Netflix.
// Si no hay sesión Netflix, deja pasar el mensaje al router original.
// ------------------------------------------------------------------------------

bot.on(
    'text',
    async (ctx, next) => {

        const id =
            ctx.chat?.id ||
            ctx.from?.id;

        const estado =
            sesionesNetflixStreaming.get(id);

        if (!estado) {
            return next();
        }

        const texto =
            (ctx.message?.text || '').trim();

        if (texto.startsWith('/')) {
            return next();
        }

        if (
            estado.modo === 'personalizado' &&
            estado.paso === 'esperando_correo'
        ) {

            if (
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(texto)
            ) {

                return ctx.reply(
                    '⚠️ Escribe un correo electrónico válido.'
                );
            }

            estado.correo = texto;
            estado.paso = 'esperando_password';

            sesionesNetflixStreaming.set(
                id,
                estado
            );

            return ctx.reply(
                `🔑 <b>Ahora escribe la contraseña ` +
                `que deseas utilizar para Netflix:</b>`,
                {
                    parse_mode: 'HTML'
                }
            );
        }


        if (
            estado.modo === 'personalizado' &&
            estado.paso === 'esperando_password'
        ) {

            if (texto.length < 8) {

                return ctx.reply(
                    '⚠️ La contraseña debe tener al menos 8 caracteres.'
                );
            }

            estado.pass = texto;
            estado.paso = 'listo';

            sesionesNetflixStreaming.set(
                id,
                estado
            );

            return ctx.reply(
                `✅ <b>DATOS NETFLIX LISTOS</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `📧 <b>Correo:</b>\n` +
                `<code>${estado.correo}</code>\n\n` +
                `🔑 <b>Contraseña:</b>\n` +
                `<code>${estado.pass}</code>\n\n` +
                `👉 Toca <b>ABRIR NETFLIX</b>.`,
                {
                    parse_mode: 'HTML',

                    ...Markup.inlineKeyboard([
                        [
                            Markup.button.callback(
                                '🚀 ABRIR NETFLIX',
                                'netflix_abrir'
                            )
                        ],

                        [
                            Markup.button.callback(
                                '❌ CANCELAR',
                                'netflix_cancelar'
                            )
                        ]
                    ])
                }
            );
        }

        return next();
    }
);


// ------------------------------------------------------------------------------
// 🌐 ABRIR NETFLIX CON PLAYWRIGHT
// SE DETIENE ANTES DE CUALQUIER PAGO
// ------------------------------------------------------------------------------

bot.action(
    'netflix_abrir',
    async ctx => {

        await ctx.answerCbQuery().catch(() => {});

        const id =
            ctx.chat?.id ||
            ctx.from?.id;

        const estado =
            sesionesNetflixStreaming.get(id);

        if (
            !estado ||
            !estado.correo ||
            !estado.pass
        ) {

            return ctx.reply(
                '⚠️ Faltan los datos de Netflix.'
            );
        }

        let navegadorNetflixLocal = null;

        try {

            await ctx.editMessageText(
                `🎬 <b>NETFLIX</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `⏳ Abriendo Netflix...`,
                {
                    parse_mode: 'HTML'
                }
            ).catch(() => {});


            navegadorNetflixLocal =
                await chromium.launch({
                    headless: ES_HEADLESS,

                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--lang=es-MX'
                    ]
                });


            const contextoNetflix =
                await navegadorNetflixLocal.newContext({
                    locale: 'es-MX',

                    timezoneId:
                        'America/Mexico_City',

                    viewport: {
                        width: 1280,
                        height: 800
                    }
                });


            const paginaNetflix =
                await contextoNetflix.newPage();


            paginaNetflix.setDefaultTimeout(
                30000
            );

            paginaNetflix.setDefaultNavigationTimeout(
                45000
            );


            await paginaNetflix.goto(
                URL_NETFLIX_STREAMING,
                {
                    waitUntil:
                        'domcontentloaded',

                    timeout:
                        45000
                }
            );


            const titulo =
                await paginaNetflix.title()
                    .catch(() => 'Netflix');


            console.log(
                `[Netflix Usuario ${id}] Página abierta: ${titulo}`
            );


            // ==========================================================
            // 🎬 NETFLIX — REGISTRO HASTA LA PANTALLA DE PAGO
            // ==========================================================

            console.log(
                `[Netflix Usuario ${id}] Iniciando registro`
            );


            // ----------------------------------------------------------
            // 1. CERRAR COOKIES / AVISO SI APARECE
            // ----------------------------------------------------------

            const cerrarAviso = paginaNetflix.locator(
                'button[aria-label="Cerrar"], ' +
                'button:has-text("Aceptar"), ' +
                '.privacy-prefs-close-btn'
            ).first();


            if (
                await cerrarAviso
                    .isVisible({ timeout: 3000 })
                    .catch(() => false)
            ) {

                await cerrarAviso
                    .click()
                    .catch(() => {});

                console.log(
                    `[Netflix Usuario ${id}] ✅ Aviso cerrado`
                );
            }


            // ----------------------------------------------------------
            // 2. CORREO
            // ----------------------------------------------------------

            const campoCorreo = paginaNetflix.locator(
                'input[name="email"], ' +
                'input[type="email"], ' +
                'input[placeholder*="Email"], ' +
                'input[placeholder*="correo"]'
            ).first();


            await campoCorreo.waitFor({
                state: 'visible',
                timeout: 30000
            });


            await campoCorreo.fill(
                estado.correo
            );


            console.log(
                `[Netflix Usuario ${id}] ✅ Correo ingresado`
            );


            // ----------------------------------------------------------
            // 3. COMENZAR / CONTINUAR
            // ----------------------------------------------------------

            const btnComenzar = paginaNetflix.locator(
                'button:has-text("Comenzar"), ' +
                'button:has-text("Continuar"), ' +
                'button[data-uia="our-story-cta"]'
            ).first();


            await btnComenzar.waitFor({
                state: 'visible',
                timeout: 15000
            });


            await btnComenzar.click();


            console.log(
                `[Netflix Usuario ${id}] ✅ Continuó después del correo`
            );


            await paginaNetflix.waitForTimeout(3000);


            // ----------------------------------------------------------
            // 4. SI NETFLIX EXIGE VERIFICACIÓN
            // ----------------------------------------------------------

            const telefono = paginaNetflix.locator(
                'input[type="tel"]'
            ).first();


            if (
                await telefono
                    .isVisible({ timeout: 1500 })
                    .catch(() => false)
            ) {

                const capturaVerificacion =
                    await paginaNetflix.screenshot({
                        fullPage: false
                    }).catch(() => null);


                if (capturaVerificacion) {

                    await ctx.replyWithPhoto(
                        {
                            source: capturaVerificacion
                        },
                        {
                            caption:
                                `⚠️ NETFLIX SOLICITA VERIFICACIÓN\n\n` +
                                `📧 ${estado.correo}\n\n` +
                                `👉 Completa la verificación requerida.`
                        }
                    ).catch(() => {});
                }


                return;
            }


            // ----------------------------------------------------------
            // 5. CREAR CONTRASEÑA / SIGUIENTE
            // ----------------------------------------------------------

            const btnCrearPass = paginaNetflix.locator(
                'button:has-text("Crear contraseña"), ' +
                'button:has-text("Siguiente"), ' +
                'button:has-text("Continuar")'
            ).first();


            if (
                await btnCrearPass
                    .isVisible({ timeout: 5000 })
                    .catch(() => false)
            ) {

                await btnCrearPass
                    .click()
                    .catch(() => {});


                await paginaNetflix.waitForTimeout(
                    2000
                );
            }


            // ----------------------------------------------------------
            // 6. CONTRASEÑA
            // ----------------------------------------------------------

            const campoPass = paginaNetflix.locator(
                'input[type="password"], ' +
                'input[name="password"], ' +
                'input[placeholder*="Contraseña"]'
            ).first();


            await campoPass.waitFor({
                state: 'visible',
                timeout: 25000
            });


            await campoPass.fill(
                estado.pass
            );


            console.log(
                `[Netflix Usuario ${id}] ✅ Contraseña ingresada`
            );


            // ----------------------------------------------------------
            // 7. CONTINUAR
            // ----------------------------------------------------------

            const btnSigPass = paginaNetflix.locator(
                'button:has-text("Siguiente"), ' +
                'button:has-text("Continuar")'
            ).first();


            await btnSigPass.waitFor({
                state: 'visible',
                timeout: 15000
            });


            await btnSigPass.click();


            console.log(
                `[Netflix Usuario ${id}] ✅ Continuó después de contraseña`
            );


            await paginaNetflix.waitForTimeout(
                3000
            );


            // ----------------------------------------------------------
            // 8. AVANZAR HACIA LOS PLANES
            // ----------------------------------------------------------

            const btnPlanes = paginaNetflix.locator(
                'button:has-text("Ver los planes"), ' +
                'button:has-text("Siguiente"), ' +
                'button:has-text("Continuar")'
            ).first();


            if (
                await btnPlanes
                    .isVisible({ timeout: 5000 })
                    .catch(() => false)
            ) {

                await btnPlanes
                    .click()
                    .catch(() => {});


                console.log(
                    `[Netflix Usuario ${id}] ✅ Avanzando a planes`
                );


                await paginaNetflix.waitForTimeout(
                    2500
                );
            }


            // ----------------------------------------------------------
            // 9. DETECTAR HASTA DÓNDE LLEGÓ
            // ----------------------------------------------------------

            const textoNetflix =
                await paginaNetflix
                    .locator('body')
                    .innerText()
                    .catch(() => '');


            const llegoPago =
                /tarjeta de crédito|tarjeta de débito|forma de pago|método de pago|elige cómo pagar/i
                    .test(textoNetflix);


            const captura =
                await paginaNetflix.screenshot({
                    fullPage: false
                }).catch(() => null);


            if (llegoPago) {

                console.log(
                    `[Netflix Usuario ${id}] ✅ Llegó a pantalla de pago`
                );


                if (captura) {

                    await ctx.replyWithPhoto(
                        {
                            source: captura
                        },
                        {
                            caption:
                                `✅ NETFLIX — REGISTRO AVANZADO\n\n` +
                                `📧 ${estado.correo}\n\n` +
                                `✅ Correo ingresado\n` +
                                `✅ Contraseña ingresada\n` +
                                `✅ Llegó hasta la pantalla de pago\n\n` +
                                `💳 Completa el pago manualmente.`
                        }
                    ).catch(() => {});

                } else {

                    await ctx.reply(
                        `✅ <b>NETFLIX — REGISTRO AVANZADO</b>\n\n` +
                        `📧 <code>${estado.correo}</code>\n\n` +
                        `✅ Llegó hasta la pantalla de pago.`,
                        {
                            parse_mode: 'HTML'
                        }
                    ).catch(() => {});
                }

            } else {

                console.log(
                    `[Netflix Usuario ${id}] ⚠️ No se detectó todavía la pantalla de pago`
                );


                if (captura) {

                    await ctx.replyWithPhoto(
                        {
                            source: captura
                        },
                        {
                            caption:
                                `⚠️ NETFLIX AVANZÓ, PERO NO SE DETECTÓ TODAVÍA LA PANTALLA DE PAGO.\n\n` +
                                `📧 ${estado.correo}`
                        }
                    ).catch(() => {});
                }
            }


        } catch (error) {

            console.error(
                `[Netflix Usuario ${id}] ERROR:`,
                error.message || error
            );


            await ctx.reply(
                `❌ <b>ERROR NETFLIX</b>\n\n` +
                `<code>${String(
                    error.message || error
                ).slice(0, 180)}</code>`,
                {
                    parse_mode: 'HTML'
                }
            ).catch(() => {});


        } finally {

            try {

                if (navegadorNetflixLocal) {

                    await navegadorNetflixLocal
                        .close()
                        .catch(() => {});
                }

            } catch (_) {}
  
    const sesionNetflix = sesionesNetflixStreaming.get(id);

    if (sesionNetflix) {
        sesionNetflix.pass = null;
        sesionNetflix.correo = null;
        sesionNetflix.paso = null;
    }

    sesionesNetflixStreaming.delete(id);

    console.log(
        `[Netflix Usuario ${id}] 🧹 Sesión Netflix reiniciada completamente`
    );
}
}
); 
// ------------------------------------------------------------------------------
// ❌ CANCELAR NETFLIX
// ------------------------------------------------------------------------------

bot.action(
    'netflix_cancelar',
    async ctx => {

        await ctx.answerCbQuery().catch(() => {});

        const id =
            ctx.chat?.id ||
            ctx.from?.id;

        sesionesNetflixStreaming.delete(id);

        return mostrarMenuCategoriasPrincipal(ctx);
    }
);

// ==============================================================================
// 🚀 INICIAR BOT
// ==============================================================================

iniciarServidorYBot();



