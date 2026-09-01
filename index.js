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
const { Telegraf, Markup } = require('telegraf');
const { chromium } = require('playwright');
require('dotenv').config();

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

if (!BOT_TOKEN) {
    console.error("❌ ERROR: La variable de entorno BOT_TOKEN no está configurada.");
}

const bot = new Telegraf(BOT_TOKEN || 'DUMMY_TOKEN', { handlerTimeout: Infinity });

bot.catch((err, ctx) => {
    console.error(`[Telegram Error] Handler error para update ${ctx?.update?.update_id}:`, err.message || err);
});

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
        .map(l => l.trim())
        .filter(l => l.length > 5 && !/^(telcel|bait|recargas|paquetes|aviso de privacidad|términos|todos los derechos|ingresa tu|número amigo)/i.test(l));
    return lineas.slice(0, 3).join(' | ').slice(0, 180) || texto.slice(0, 140);
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

    // 1️⃣ PRIORIDAD MÁXIMA: RECHAZOS BANCARIOS Y FONDOS INSUFICIENTES (Evaluados primero)
    const esFondos = /(fondos\s*insuficientes)|(saldo\s*insuficiente)|(saldo\s*no\s*disponible)|(sin\s*fondos)|(monto\s*no\s*adecuado)|(monto\s*insuficiente)|(no\s*cuenta\s*con\s*fondos)/i.test(txt);
    
    const esTarjetaRechazada = /(tarjeta\s*(inv[áa]lida|no\s*v[áa]lida|rechazada|no\s*soportada|no\s*aceptada|no\s*permitida|declinada))|(n[úu]mero\s*de\s*tarjeta\s*inv[áa]lido)|(cvv\s*incorrecto)|(fecha\s*de\s*vencimiento\s*inv[áa]lida)|(vencimiento\s*inv[áa]lido)|(emisor\s*no\s*soportado)|(tipo\s*de\s*tarjeta\s*no\s*v[áa]lida)|(entidad\s*rechaz[óo])|(bloqueo\s*por\s*seguridad)|(l[íi]mite\s*diario)|(no\s*autorizada\s*por\s*el\s*banco)|(rechazada\s*por\s*el\s*banco)|(intenta\s*con\s*otra\s*tarjeta)|(intente\s*con\s*otra\s*tarjeta)|(consulte\s*con\s*el\s*emisor)|(transacci[óo]n\s*no\s*autorizada)|(no\s*se\s*pudo\s*procesar\s*su\s*pago)|(no\s*se\s*pudo\s*completar\s*el\s*pago)|(pago\s*no\s*autorizado)|(operaci[óo]n\s*declinada)|(pago\s*declinado)/i.test(txt);

    const esErrorGenericoBanco = /(tu\s*solicitud\s*no\s*pudo\s*ser\s*(completada|procesada))|(no\s*se\s*pudo\s*realizar\s*(el\s*pago|la\s*operaci[óo]n))|(transacci[óo]n\s*rechazada)|(pago\s*rechazado)|(error\s*al\s*procesar\s*el\s*pago)|(pago\s*no\s*aplicado)|(cobro\s*rechazado)|(lo\s*sentimos,?\s*no\s*pudimos\s*procesar)/i.test(txt);

    if (esFondos) {
        return {
            estado: 'RECHAZO_BANCARIO',
            subtipo: 'FONDOS_INSUFICIENTES',
            titulo: '❌ RECARGA NO COMPLETADA: FONDOS / MONTO INSUFICIENTE',
            icono: '💸',
            explicacion: 'La tarjeta no cuenta con fondos suficientes o el monto fue declinado por el banco emisor.'
        };
    }

    if (esTarjetaRechazada || esErrorGenericoBanco) {
        return {
            estado: 'RECHAZO_BANCARIO',
            subtipo: 'TARJETA_DECLINADA',
            titulo: '❌ RECARGA NO COMPLETADA: TRANSACCIÓN DECLINADA',
            icono: '💳',
            explicacion: 'El banco emisor declinó la transacción o rechazó la tarjeta ingresada.'
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
    const esProcesando = /(tu\s*recarga\s*est[áa]\s*en\s*proceso)|(recarga\s*en\s*proceso)|(pago\s*en\s*proceso)|(procesando\s*tu\s*(pago|recarga))|(espera\s*la\s*confirmaci[óo]n)|(estamos\s*procesando\s*tu\s*solicitud)|(validando\s*transacci[óo]n)|(en\s*validaci[óo]n)|(transacci[óo]n\s*pendiente)/i.test(txt);

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

    if (tieneFolioOComprobante || (esAprobacionExplicita && !/(en\s*proceso|pendiente|iniciad[oa]|error|rechaz)/i.test(txt))) {
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
// 🧠 2.4 CLASIFICADOR INTELIGENTE TELCEL (ORDEN ESTRICTO: RECHAZO -> BLOQUEO -> PROCESANDO -> EXITO -> DESCONOCIDO)
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

    // 1️⃣ PRIORIDAD MÁXIMA: RECHAZO BANCARIO Y FONDOS INSUFICIENTES (Gana siempre sobre éxito)
    const esFondos = /(fondos\s*insuficientes)|(saldo\s*insuficiente)|(saldo\s*no\s*disponible)|(sin\s*fondos)|(monto\s*no\s*adecuado)|(monto\s*insuficiente)|(no\s*cuenta\s*con\s*fondos)|(no\s*tiene\s*fondos)/i.test(txt);
    
    const esTarjetaRechazada = /(tarjeta\s*(inv[áa]lida|no\s*v[áa]lida|rechazada|no\s*soportada|no\s*aceptada|no\s*reconocida|no\s*permitida|declinada))|(n[úu]mero\s*de\s*tarjeta\s*inv[áa]lido)|(cvv\s*incorrecto)|(fecha\s*de\s*vencimiento\s*inv[áa]lida)|(vencimiento\s*inv[áa]lido)|(emisor\s*no\s*soportado)|(tipo\s*de\s*tarjeta\s*no\s*v[áa]lida)|(revisa\s*el\s*n[úu]mero\s*de\s*tarjeta)|(bin\s*(inv[áa]lido|no\s*v[áa]lido|no\s*soportado))|(entidad\s*rechaz[óo])|(no\s*autorizada\s*por\s*el\s*banco)|(rechazada\s*por\s*el\s*banco)|(intenta\s*con\s*otra\s*tarjeta)|(intente\s*con\s*otra\s*tarjeta)|(consulte\s*con\s*el\s*emisor)|(transacci[óo]n\s*no\s*autorizada)|(no\s*se\s*pudo\s*procesar\s*su\s*pago)|(no\s*se\s*pudo\s*completar\s*el\s*pago)|(pago\s*no\s*autorizado)|(operaci[óo]n\s*declinada)|(pago\s*declinado)/i.test(txt);

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

    // 2️⃣ BLOQUEO TELCEL / RESTRICCIÓN / ERROR GENÉRICO
    const esBloqueoTelcel = /(bloqueo\s*por\s*seguridad)|(l[íi]mite\s*diario)|(l[íi]mite\s*de\s*intentos)|(excediste\s*el\s*l[íi]mite)|(int[ée]ntalo\s*m[áa]s\s*tarde)|(transacci[óo]n\s*bloqueada)/i.test(txt);
    const esGenericoTelcel = /(tu\s*solicitud\s*no\s*pudo\s*ser\s*(completada|procesada))|(no\s*se\s*pudo\s*realizar\s*(el\s*pago|la\s*operaci[óo]n))|(transacci[óo]n\s*rechazada)|(pago\s*rechazado)|(error\s*al\s*procesar)|(hubo\s*un\s*problema\s*al\s*procesar)|(pago\s*no\s*aplicado)|(cobro\s*rechazado)/i.test(txt);

    const historial = historialErroresUsuario.get(id) || [];
    const errorActualLimpio = textoCompleto.trim().replace(/\s+/g, ' ').slice(0, 100);
    const esRepetido = historial.some(e => e && e.length > 10 && errorActualLimpio.includes(e.slice(0, 30)));
    historial.push(errorActualLimpio);
    historialErroresUsuario.set(id, historial);

    if (esBloqueoTelcel || (esGenericoTelcel && esRepetido)) {
        return {
            estado: 'BLOQUEO_TELCEL',
            subtipo: 'POSIBLE_LISTA_NEGRA',
            titulo: '⛔ POSIBLE BLOQUEO TELCEL / LISTA NEGRA',
            icono: '⛔',
            explicacion: 'Restricción de la plataforma Telcel por uso repetido, IP o filtro de riesgo.'
        };
    }

    if (esGenericoTelcel) {
        return {
            estado: 'RECHAZO_BANCARIO',
            subtipo: 'ERROR_TRANSACCION',
            titulo: '❌ RECARGA NO COMPLETADA: PAGO NO PROCESADO',
            icono: '💳',
            explicacion: 'La plataforma no pudo procesar el cobro con la tarjeta proporcionada.'
        };
    }

    // 3️⃣ PROCESANDO / PENDIENTE (JAMÁS SE CONSIDERA ÉXITO)
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

    // 4️⃣ ÉXITO REAL (Exigir confirmación final explícita de recarga/pago exitoso)
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

    // 5️⃣ ESTADO NO DETERMINADO
    return {
        estado: 'DESCONOCIDO',
        subtipo: 'ERROR_TEMPORAL',
        titulo: '⚠️ ERROR TEMPORAL / DESCONOCIDO',
        icono: '⚠️',
        explicacion: 'Respuesta no clasificada del portal Telcel.'
    };
}

// ==============================================================================
// 🌐 3. NAVEGADOR TELCEL
// ==============================================================================
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
async function abrirMasPaquetes(pagina, monto) {
    await pagina.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const botonVerMas = pagina.locator('button:has(p:has-text("Ver más paquetes")), button:has-text("Ver más paquetes")');
    if (await botonVerMas.isVisible({ timeout: 4000 }).catch(() => false)) {
        await botonVerMas.scrollIntoViewIfNeeded().catch(() => {});
        await botonVerMas.click({ force: true }).catch(() => {});
        await pagina.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    }

    const regexCosto = new RegExp(`^\\$?\\s*${monto}$`, 'i');
    const tarjetaEsperada = pagina.locator('div.Plan_package__zO1Ss, div[class*="Plan_package__"]')
        .filter({ has: pagina.locator('b.Plan_b__DrgD_, [class*="Plan_b__"]').filter({ hasText: regexCosto }) })
        .filter({ has: pagina.locator('b.Plan_buttonPackageLabel__xB_jv, b:has-text("Lo quiero")') });

    await tarjetaEsperada.waitFor({ state: 'attached', timeout: 25000 }).catch(() => {});
}

async function seleccionarPaquete(pagina, monto) {
    await pagina.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const regexCosto = new RegExp(`^\\$?\\s*${monto}$`, 'i');
    const tarjeta = pagina.locator('div.Plan_package__zO1Ss, div[class*="Plan_package__"]')
        .filter({ has: pagina.locator('b.Plan_b__DrgD_, [class*="Plan_b__"]').filter({ hasText: regexCosto }) })
        .filter({ has: pagina.locator('b.Plan_buttonPackageLabel__xB_jv, b:has-text("Lo quiero")') });

    await tarjeta.waitFor({ state: 'attached', timeout: 20000 });
    await tarjeta.waitFor({ state: 'visible', timeout: 20000 });

    const botonLoQuiero = tarjeta.locator('b.Plan_buttonPackageLabel__xB_jv, b:has-text("Lo quiero"), button:has-text("Lo quiero")');
    await botonLoQuiero.scrollIntoViewIfNeeded().catch(() => {});
    await botonLoQuiero.waitFor({ state: 'visible', timeout: 15000 });

    if (!(await botonLoQuiero.isEnabled().catch(() => false))) {
        throw new Error(`BOTON_LO_QUIERO_$${monto}_NO_HABILITADO`);
    }

    await botonLoQuiero.click({ force: true });
    await pagina.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

async function ejecutarConReintento(fn, intentosMax = 3, id) {
    let ultimoError = null;
    for (let intento = 1; intento <= intentosMax; intento++) {
        try {
            return await fn(intento);
        } catch (error) {
            ultimoError = error;
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
        await ejecutarConReintento(async () => {
            const miId = (ejecucionesUsuario.get(id) || 0) + 1;
            ejecucionesUsuario.set(id, miId);

            let sesion = null;
            let pagina = null;

            try {
                ultimaEtapa = "Apertura de navegador";
                sesion = await lanzarNavegador(id);
                pagina = sesion.pagina;

                pagina.on('dialog', async dialog => {
                    await dialog.accept().catch(() => {});
                });

                pagina.on('popup', async popup => {
                    await aceptarUbicacionSiAparece(popup);
                    await popup.close().catch(() => {});
                });

                ultimaEtapa = "Navegación a Telcel Pay";
                await pagina.goto(URL_TELCEL, { waitUntil: 'commit', timeout: 45000 });
                await pagina.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
                await pagina.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

                await aceptarUbicacionSiAparece(pagina);

                ultimaEtapa = "Apertura de paquetes adicionales";
                await abrirMasPaquetes(pagina, monto);

                ultimaEtapa = `Selección de paquete $${monto}`;
                await seleccionarPaquete(pagina, monto);

                ultimaEtapa = "Ingreso de número celular";
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

                const btnContinuarTel = pagina.locator('button.fontBoldAMX:has-text("Continuar"), button.bg-\\[\\#7b1fa2\\]:has-text("Continuar"), button:has-text("Continuar"), button[type="submit"]').first();
                await btnContinuarTel.waitFor({ state: 'visible', timeout: 25000 });
                await btnContinuarTel.scrollIntoViewIfNeeded().catch(() => {});
                await btnContinuarTel.click({ force: true });
                await pagina.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

                ultimaEtapa = "Llenado de datos de tarjeta";
                const inputCC = pagina.locator('input#creditCardNumber, input[placeholder*="16 dígitos" i], input[name="cardNumber"]').first();
                await inputCC.waitFor({ state: 'attached', timeout: 30000 });
                await inputCC.waitFor({ state: 'visible', timeout: 30000 });

                if (!(await inputCC.isEditable().catch(() => false)) || !(await inputCC.isEnabled().catch(() => false))) {
                    throw new Error("CAMPO_TARJETA_NO_DISPONIBLE");
                }

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

                // 4. ESPERA ACTIVA REDUCIDA (MÁXIMO 40s CON POLLING ACTIVO DE 500ms)
                ultimaEtapa = "Analizando respuesta y comprobante";
                const inicioEspera = Date.now();
                const TIEMPO_MAXIMO_ESPERA_TELCEL_MS = 40000;
                let textoFinalPagina = "";
                let clasificacionFinal = null;

                while (Date.now() - inicioEspera < TIEMPO_MAXIMO_ESPERA_TELCEL_MS) {
                    textoFinalPagina = await pagina.evaluate(() => {
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
                            'main',
                            'body'
                        ];

                        const esVisible = el => {
                            if (!el) return false;
                            const s = window.getComputedStyle(el);
                            return s && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
                        };

                        let fragmentos = [];
                        for (const sel of selectores) {
                            document.querySelectorAll(sel).forEach(el => {
                                if (esVisible(el)) {
                                    const t = (el.innerText || '').trim();
                                    if (t.length > 0 && !fragmentos.includes(t)) {
                                        fragmentos.push(t);
                                    }
                                }
                            });
                        }
                        return fragmentos.join(' \n ');
                    }).catch(() => '');

                    clasificacionFinal = clasificarResultadoTelcel(textoFinalPagina, id);

                    // Si se detecta un estado determinante, salir de inmediato sin esperar el timeout
                    if (['EXITO', 'RECHAZO_BANCARIO', 'BLOQUEO_TELCEL', 'PROCESANDO'].includes(clasificacionFinal.estado)) {
                        break;
                    }

                    await pagina.waitForTimeout(500);
                }

                if (!clasificacionFinal || clasificacionFinal.estado === 'DESCONOCIDO') {
                    clasificacionFinal = clasificarResultadoTelcel(textoFinalPagina, id);
                }

                if (miId === ejecucionesUsuario.get(id)) {
                    const fragmentoLeido = extraerFragmentoClave(textoFinalPagina);
                    const capturaVoucher = await tomarCapturaEnfocada(pagina);

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
                            `📄 <b>Estado:</b> "<i>${fragmentoLeido}</i>"\n\n` +
                            `ℹ️ ▫️ La solicitud fue enviada y se encuentra en validación.\n` +
                            `👉 <b>Toca /start para realizar otra operación.</b>`;

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
                            `📄 <b>Detalle:</b> "<i>${fragmentoLeido}</i>"\n\n` +
                            `👉 <b>Toca /start para reiniciar.</b>`;

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
                if (pagina && !pagina.isClosed()) {
                    ultimaCapturaError = await tomarCapturaEnfocada(pagina);
                }
                throw errIntento;
            } finally {
                await cerrarSesionNavegador(id);
            }
        }, 3, id);

    } catch (errTelcel) {
        console.error(`[Usuario ${id}] ❌ Fallo total:`, errTelcel.message || errTelcel);
        await limpiarMensajesTemporales(ctx, id);

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
    'iframe[name*="zoid" i]',
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

// 5. APERTURA DE PAQUETE, MODAL, LLENADO Y AVANCE
async function abrirPaqueteBait(pag, id, numero, correo, monto = 300) {
    await pag.goto(URL_BAIT, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await aceptarCookiesBait(pag, id);

    const primerCard = pag.locator('app-card-recharge').first();
    await primerCard.waitFor({ state: 'visible', timeout: 12000 });
    await aceptarCookiesBait(pag, id);

    const selectoresCard = getSelectoresPaqueteBait(monto);
    let cardBtn = null;

    for (const sel of selectoresCard) {
        try {
            const el = pag.locator(sel).first();
            if (await el.isVisible({ timeout: 200 }).catch(() => false)) {
                cardBtn = el;
                break;
            }
        } catch(e) {}
    }

    if (!cardBtn) {
        cardBtn = pag.locator(`app-card-recharge:has(img[alt*="${monto}" i]) button, app-card-recharge:has(img[src*="${monto}"]) button, img[alt*="${monto}" i]`).first();
    }

    await cardBtn.waitFor({ state: 'visible', timeout: 12000 });
    await cardBtn.scrollIntoViewIfNeeded().catch(() => {});
    if (!(await cardBtn.isEnabled().catch(() => false))) {
        throw new Error("BOTON_PAQUETE_BAIT_DESHABILITADO");
    }
    await cardBtn.click();

    // Detectar el modal real mediante dialog[open]
    const modal = pag.locator('dialog[open]').first();
    await modal.waitFor({ state: 'visible', timeout: 15000 });

    // Llenar teléfono y correo
    const inputTel = modal.locator(BAIT_SEL.TEL).first();
    await inputTel.waitFor({ state: 'visible', timeout: 8000 });
    await inputTel.click({ force: true });
    await inputTel.fill(numero, { force: true });
    await inputTel.dispatchEvent('input', { bubbles: true }).catch(() => {});
    await inputTel.dispatchEvent('change', { bubbles: true }).catch(() => {});
    await inputTel.dispatchEvent('blur', { bubbles: true }).catch(() => {});

    const inputMail = modal.locator(BAIT_SEL.CORREO).first();
    await inputMail.waitFor({ state: 'visible', timeout: 8000 });
    await inputMail.click({ force: true });
    await inputMail.fill(correo, { force: true });
    await inputMail.dispatchEvent('input', { bubbles: true }).catch(() => {});
    await inputMail.dispatchEvent('change', { bubbles: true }).catch(() => {});
    await inputMail.dispatchEvent('blur', { bubbles: true }).catch(() => {});

    await pag.waitForTimeout(600);

    // Detectar y esperar a que el botón de avance se habilite naturalmente
    const inicioEspera = Date.now();
    const TIMEOUT_AVANCE_MS = 18000;
    let btnEncontrado = null;
    let selectorExitoso = '';

    while (Date.now() - inicioEspera < TIMEOUT_AVANCE_MS) {
        for (const sel of BAIT_SEL.BOTON_AVANCE_AMARILLO) {
            try {
                const b = pag.locator(sel).first();
                if (await b.isVisible({ timeout: 60 }).catch(() => false)) {
                    btnEncontrado = b;
                    selectorExitoso = sel;
                    break;
                }
            } catch(e) {}
        }

        if (!btnEncontrado) {
            for (const sel of BAIT_SEL.BOTON_AVANCE_NEGRO) {
                try {
                    const b = modal.locator(sel).first();
                    if (await b.isVisible({ timeout: 60 }).catch(() => false)) {
                        btnEncontrado = b;
                        selectorExitoso = sel;
                        break;
                    }
                } catch(e) {}
            }
        }

        if (btnEncontrado) {
            await btnEncontrado.scrollIntoViewIfNeeded().catch(() => {});
            if (await btnEncontrado.isEnabled().catch(() => false)) {
                await btnEncontrado.click();
                await pag.waitForTimeout(800);
                return true;
            }
            // Si está visible pero aún no habilitado, no forzar clic y seguir esperando naturalmente
            btnEncontrado = null;
        }

        await pag.waitForTimeout(150);
    }

    throw new Error("FALLO_ABRIR_PAQUETE: Botón de avance deshabilitado o no interactivo");
}

// 6. DETECTOR DE PASARELA SIMPLE (OBSERVADOR PURO — TIMEOUT: 5000ms, POLLING: 120ms)
async function detectarPasarelaBait(pag, id) {
    const inicio = Date.now();
    const TIMEOUT_DETECCION_MS = 5000;

    while (Date.now() - inicio < TIMEOUT_DETECCION_MS) {
        const popup = popupsActivosBait.get(id);
        const paginasARevisar = [pag];
        if (popup && typeof popup.isClosed === 'function' && !popup.isClosed()) {
            paginasARevisar.push(popup);
        }

        // 1. Revisar si inequívocamente apareció otra pasarela conocida (Conekta / SPEI / OXXO)
        for (const p of paginasARevisar) {
            const txt = await p.evaluate(() => (document.body ? document.body.innerText : '') || '').catch(() => '');
            if (/conekta/i.test(txt) || /paga seguro con/i.test(txt) || /efectivo en oxxo/i.test(txt) || /spei/i.test(txt)) {
                return 'OTRA_PASARELA';
            }
        }

        // 2. Revisar URL de página y popup
        for (const p of paginasARevisar) {
            const pUrl = (p.url() || '').toLowerCase();
            if (pUrl.includes('paypal')) {
                return 'PAYPAL';
            }
        }

        // 3. Revisar URL y nombre de frames
        for (const p of paginasARevisar) {
            const frames = p.frames ? p.frames() : [];
            for (const f of frames) {
                const fUrl = (f.url() || '').toLowerCase();
                const fName = (f.name() || '').toLowerCase();
                if (fUrl.includes('paypal') || fName.includes('paypal') || fName.includes('zoid')) {
                    return 'PAYPAL';
                }
            }
        }

        // 4. Revisar selectores específicos de PayPal
        for (const p of paginasARevisar) {
            for (const sel of BAIT_SEL.PASARELA_PAYPAL) {
                try {
                    const el = p.locator(sel).first();
                    if (await el.isVisible({ timeout: 30 }).catch(() => false) || (await el.count().catch(() => 0)) > 0) {
                        return 'PAYPAL';
                    }
                } catch(e) {}
            }
        }

        // 5. Revisar texto visible como último recurso
        for (const p of paginasARevisar) {
            const txt = await p.evaluate(() => (document.body ? document.body.innerText : '') || '').catch(() => '');
            if (/paypal/i.test(txt)) {
                return 'PAYPAL';
            }
        }

        await pag.waitForTimeout(120);
    }

    return 'TIMEOUT';
}

// 7. DIAGNÓSTICO Y ELEMENTOS INTERNOS DE PAYPAL
async function paso3DiagnosticoYElementosPayPalBait(pag, id, datos, monto = 300) {
    const popup = popupsActivosBait.get(id);
    const target = (popup && !popup.isClosed()) ? popup : pag;
    const contexto = pag.context();
    const paginasActivas = contexto ? contexto.pages() : [pag];
    const framesTotales = target.frames ? target.frames() : [];
    const framesPayPal = framesTotales.filter(f => (f.url() || '').toLowerCase().includes('paypal') || (f.name() || '').toLowerCase().includes('paypal') || (f.name() || '').toLowerCase().includes('zoid'));
    const textoVisible = await target.evaluate(() => (document.body ? document.body.innerText : '') || '').catch(() => '');
    const lineasPayPal = textoVisible.split('\n').map(l => l.trim()).filter(l => /paypal|tarjeta|pago/i.test(l)).join(' | ').slice(0, 200);

    console.log("==================================================");
    console.log(`[Bait Usuario ${id}] PASO 1 OK`);
    console.log(`[Bait Usuario ${id}] PASO 2 OK — PAYPAL DETECTADO`);
    console.log(`[Bait Usuario ${id}] URL: ${target.url()}`);
    console.log(`[Bait Usuario ${id}] cantidad de páginas: ${paginasActivas.length}`);
    console.log(`[Bait Usuario ${id}] cantidad de frames: ${framesTotales.length}`);
    console.log(`[Bait Usuario ${id}] frames relacionados con PayPal (${framesPayPal.length}):`, framesPayPal.map(f => ({ name: f.name(), url: f.url().slice(0, 80) })));
    console.log(`[Bait Usuario ${id}] texto visible relacionado con PayPal: "${lineasPayPal}"`);
    console.log("==================================================");

    try {
        await paso3HacerClicTarjetaBait(pag, id);
        await paso3LlenarTarjetaYConfirmarBait(pag, id, datos);
        const resConfirmacion = await paso3ConfirmarTerminosYPagarAhoraBait(pag, id, monto);
        return resConfirmacion;
    } catch (errInterno) {
        console.log(`[Bait Usuario ${id}] ⚠️ Detalle en interacción interna PayPal: ${errInterno.message}.`);
        return {
            exito: false,
            pasarelaConfirmada: true,
            clasificacion: {
                estado: 'ERROR_PASARELA',
                subtipo: 'FALLO_INTERNO_PAYPAL',
                titulo: '⚠️ ERROR EN PROCESO DE PAGO',
                icono: '⚠️',
                explicacion: 'Ocurrió un error al interactuar con el formulario de pago de PayPal.'
            },
            textoLeido: errInterno.message || 'Error técnico en pasarela'
        };
    }
}

async function paso3HacerClicTarjetaBait(pag, id) {
    console.log(`[Bait Usuario ${id}] 🔍 PASO 3: Localizando botón de tarjeta dentro de PayPal...`);
    const inicio = Date.now();
    const TIMEOUT_TARJETA_MS = 20000;
    let clickRealizado = false;

    while (Date.now() - inicio < TIMEOUT_TARJETA_MS) {
        const popup = popupsActivosBait.get(id);
        const targetContext = (popup && !popup.isClosed()) ? popup : pag;
        const frames = targetContext.frames ? targetContext.frames() : [targetContext];

        // 1. Revisar frames individualmente buscando el botón de tarjeta
        for (const f of frames) {
            for (const sel of BAIT_SEL.BOTON_TARJETA) {
                try {
                    const btn = f.locator(sel).first();
                    if (await btn.isVisible({ timeout: 60 }).catch(() => false)) {
                        await btn.scrollIntoViewIfNeeded().catch(() => {});
                        await btn.click({ force: true });
                        clickRealizado = true;
                        console.log(`[Bait Usuario ${id}] 💳 Clic exitoso en botón de Tarjeta: ${sel} (en frame: ${f.name() || 'principal'})`);
                        break;
                    }
                } catch(e) {}
            }
            if (clickRealizado) break;
        }

        // 2. Fallback DOM evaluate individual por frame
        if (!clickRealizado) {
            for (const f of frames) {
                try {
                    clickRealizado = await f.evaluate(() => {
                        const btnCard = document.querySelector('div[data-funding-source="card"], [role="button"][data-funding-source="card"], [role="link"][data-funding-source="card"], .paypal-button[data-funding-source="card"], [aria-label*="Tarjeta de débito" i]');
                        if (btnCard) {
                            btnCard.click();
                            return true;
                        }
                        return false;
                    }).catch(() => false);
                    if (clickRealizado) {
                        console.log(`[Bait Usuario ${id}] 💳 Clic vía DOM evaluate en botón de Tarjeta (en frame: ${f.name() || 'principal'})`);
                        break;
                    }
                } catch(e) {}
            }
        }

        if (clickRealizado) break;
        await pag.waitForTimeout(250);
    }

    return clickRealizado;
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

    const framesPayPal = targetContext.frames ? targetContext.frames().filter(f => f !== targetContext && ((f.url() || '').includes('paypal') || (f.name() || '').includes('paypal'))) : [];
    const contextosPrioritarios = [targetContext, ...framesPayPal, ...(targetContext.frames ? targetContext.frames() : [])];

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

    await pag.waitForTimeout(400);

    // 12. Botón Pagar en la pasarela de tarjeta
    const selectoresBotonPagar = [
        'button#submit-button',
        `button#submit-button:has-text("Pagar")`,
        `button:has-text("Pagar $${monto}")`,
        `button:has-text("Pagar $${monto}.00")`,
        `button:has-text("Pagar $${monto}.00 MXN")`,
        'button.css-aezqgw-button-Button',
        'button[class*="button-Button"]:has-text("Pagar")',
        'button[type="button"]:has-text("Pagar")',
        'button:has-text("Pagar $")',
        'button:has-text("Pagar")',
        'button:has-text("Continuar")',
        'button[type="submit"]:has-text("Pagar")',
        'button[type="submit"]',
        '#submit-button'
    ];

    let clickPagar = false;
    const inicioEsperaPago = Date.now();
    const TIMEOUT_BTN_PAGO = 10000;

    while (Date.now() - inicioEsperaPago < TIMEOUT_BTN_PAGO) {
        for (const ctx of contextosPrioritarios) {
            for (const sel of selectoresBotonPagar) {
                try {
                    const btn = ctx.locator(sel).first();
                    if (await btn.isVisible({ timeout: 100 }).catch(() => false)) {
                        await btn.scrollIntoViewIfNeeded().catch(() => {});
                        await btn.click({ force: true });
                        clickPagar = true;
                        console.log(`[Bait Usuario ${id}] 💸 Clic en botón Pagar de pasarela (${sel})`);
                        break;
                    }
                } catch(e) {}
            }
            if (clickPagar) break;
        }
        if (clickPagar) break;
        await pag.waitForTimeout(150);
    }

    return { exito: true, consentChecked, clickPagar, targetContext };
}

async function paso3ConfirmarTerminosYPagarAhoraBait(pag, id, monto = 300) {
    await pag.waitForTimeout(2000);

    const inicioEsperaCheckout = Date.now();
    const TIMEOUT_CHECKOUT_MS = 20000;
    let botonPagarAhoraClickeado = false;

    while (Date.now() - inicioEsperaCheckout < TIMEOUT_CHECKOUT_MS) {
        const selectoresCheckboxBait = [
            'label:has-text("He leído, entiendo y consiento") input[type="checkbox"]',
            'div:has-text("Aviso de Privacidad") input[type="checkbox"]',
            'input[type="checkbox"]'
        ];

        let cbMarcada = false;
        for (const sel of selectoresCheckboxBait) {
            try {
                const cbs = pag.locator(sel);
                const count = await cbs.count().catch(() => 0);
                if (count > 0) {
                    const cb = cbs.first();
                    await cb.scrollIntoViewIfNeeded().catch(() => {});
                    await cb.check({ force: true }).catch(() => cb.click({ force: true }));
                    cbMarcada = true;
                    break;
                }
            } catch(e) {}
        }

        if (!cbMarcada) {
            const allCbs = pag.locator('input[type="checkbox"]');
            const total = await allCbs.count().catch(() => 0);
            for (let i = 0; i < total; i++) {
                await allCbs.nth(i).check({ force: true }).catch(() => allCbs.nth(i).click({ force: true })).catch(() => {});
            }
        }

        await pag.waitForTimeout(200);

        const selectoresPagarAhora = [
            'button:has-text("Pagar ahora")',
            'button:has-text("PAGAR AHORA")',
            'button:has-text("Pagar Ahora")',
            'button.ph-bait-ex-85__submit:has-text("Pagar")',
            'button:has-text("Pagar")',
            'button[type="submit"]'
        ];

        for (const sel of selectoresPagarAhora) {
            try {
                const btn = pag.locator(sel).first();
                if (await btn.isVisible({ timeout: 100 }).catch(() => false)) {
                    await btn.scrollIntoViewIfNeeded().catch(() => {});
                    await btn.click({ force: true });
                    botonPagarAhoraClickeado = true;
                    console.log(`[Bait Usuario ${id}] 🚀 Clic en botón final PAGAR AHORA`);
                    break;
                }
            } catch(e) {}
        }

        if (botonPagarAhoraClickeado) break;

        const textoBody = await pag.evaluate(() => (document.body ? document.body.innerText : '') || '').catch(() => '');
        if (/(éxito)|(exitosa)|(recarga\s*exitosa)|(pago\s*exitoso)|(folio)|(fondos\s*insuficientes)|(tarjeta\s*rechazada)|(declinada)/i.test(textoBody)) {
            break;
        }

        await pag.waitForTimeout(300);
    }

    let textoFinalPagina = "";
    let clasificacionFinal = null;
    const inicioEsperaRespuesta = Date.now();
    const TIEMPO_ESPERA_RESPUESTA_MS = 40000;

    while (Date.now() - inicioEsperaRespuesta < TIEMPO_ESPERA_RESPUESTA_MS) {
        textoFinalPagina = await pag.evaluate(() => {
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
                'app-root main'
            ];

            const esVisible = el => {
                if (!el) return false;
                const s = window.getComputedStyle(el);
                return s && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
            };

            let fragmentos = [];
            for (const sel of selectores) {
                document.querySelectorAll(sel).forEach(el => {
                    if (esVisible(el)) {
                        const t = (el.innerText || '').trim();
                        if (t.length > 0 && !fragmentos.includes(t)) {
                            fragmentos.push(t);
                        }
                    }
                });
            }
            return fragmentos.join(' \n ');
        }).catch(() => '');

        clasificacionFinal = clasificarResultadoBait(textoFinalPagina, id);

        if (['EXITO', 'RECHAZO_BANCARIO', 'ERROR_PASARELA', 'PROCESANDO'].includes(clasificacionFinal.estado)) {
            break;
        }

        await pag.waitForTimeout(500);
    }

    if (!clasificacionFinal || clasificacionFinal.estado === 'DESCONOCIDO') {
        clasificacionFinal = clasificarResultadoBait(textoFinalPagina, id);
    }

    return {
        exito: clasificacionFinal.estado === 'EXITO',
        botonPagarAhoraClickeado,
        clasificacion: clasificacionFinal,
        textoLeido: extraerFragmentoClave(textoFinalPagina)
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

        console.log(`🔍 [Bait Usuario ${id}] Buscando pasarela (Timeout: 5s)...`);
        const t0 = Date.now();
        const estadoPasarela = await detectarPasarelaBait(pag, id);
        const transcurrido = Date.now() - t0;

        if (estadoPasarela === 'PAYPAL') {
            console.log(`✅ [Bait Usuario ${id}] PayPal detectado en ${transcurrido} ms`);
            pasarelaDetectada = true;
            const resultadoFinalBait = await paso3DiagnosticoYElementosPayPalBait(pag, id, datosCompletos, monto);
            return {
                exito: resultadoFinalBait.exito,
                pag,
                contexto,
                datos: datosCompletos,
                resultado: resultadoFinalBait,
                pasarelaDetectada: true
            };
        }

        if (estadoPasarela === 'OTRA_PASARELA') {
            console.log(`⚠️ [Bait Usuario ${id}] Otra pasarela detectada en ${transcurrido} ms`);
        } else {
            console.log(`⏱️ [Bait Usuario ${id}] Timeout de 5s sin PayPal (${transcurrido} ms)`);
        }

        await cerrarContextoBait(contexto, id);
        console.log(`🧹 [Bait Usuario ${id}] Contexto cerrado`);
        return { exito: false, pasarelaDetectada: false };

    } catch (err) {
        if (pasarelaDetectada && pag && !pag.isClosed()) {
            console.log(`[Bait Usuario ${id}] ⚠️ Error posterior a detectar PayPal: ${err.message}. Retornando ERROR_POST_PAYPAL.`);
            let captura = null;
            try {
                captura = await tomarCapturaEnfocada(pag);
            } catch(e) {}

            return {
                exito: false,
                pag,
                contexto,
                datos: datosCompletos,
                pasarelaDetectada: true,
                resultado: {
                    exito: false,
                    clasificacion: {
                        estado: 'ERROR_POST_PAYPAL',
                        subtipo: 'EXCEPCION_INTERNA',
                        titulo: '⚠️ ERROR POSTERIOR A PAYPAL',
                        icono: '⚠️',
                        explicacion: 'Se detectó PayPal pero ocurrió una falla al procesar la información.'
                    },
                    textoLeido: err.message || 'Error técnico en pasarela'
                },
                captura
            };
        }

        let capturaError = null;
        if (pag && !pag.isClosed()) {
            capturaError = await tomarCapturaEnfocada(pag);
        }
        await cerrarContextoBait(contexto, id);
        console.log(`🧹 [Bait Usuario ${id}] Contexto cerrado tras excepción`);
        return { exito: false, pag: null, error: err, captura: capturaError, pasarelaDetectada: false };
    }
}

// 9. FLUJO PRINCIPAL BAIT (UN SOLO CHROMIUM — CONTROL DE CICLO DE VIDA)
async function flujoBait(ctx, id, datos) {
    const { numero, monto: montoIn } = datos;
    const monto = montoIn || 300;

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

        if (resultadoFinal && resultadoFinal.pag) {
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
            
            let captura = resultadoFinal.captura;
            if (!captura) {
                captura = await tomarCapturaEnfocada(pag);
            }

            await limpiarMensajesTemporales(ctx, id);

            let captionFinal = '';

            if (clasif.estado === 'EXITO') {
                captionFinal =
                    `🦁 <b>BOT LEÓN — COMPROBANTE DE RECARGA EXITOSA</b> ✅\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📱 <b>Línea:</b> <code>${numero}</code>\n` +
                    `💲 <b>Monto:</b> $${monto} MXN\n` +
                    `✅ <b>Estado:</b> Recarga aprobada y aplicada\n` +
                    `📄 <b>Folio / Ticket:</b> "<i>${fragmento}</i>"\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `👉 <b>Toca /start para realizar otra recarga.</b>`;

                if (captura) {
                    await ctx.replyWithPhoto({ source: captura }, {
                        caption: captionFinal.slice(0, 1024),
                        parse_mode: 'HTML'
                    });
                } else {
                    await ctx.replyWithHTML(captionFinal);
                }

            } else if (clasif.estado === 'RECHAZO_BANCARIO') {
                const sPrev = sesiones.get(id) || {};
                const intentos = (sPrev.intentosTarjeta || 0) + 1;
                sPrev.intentosTarjeta = intentos;
                sesiones.set(id, sPrev);

                if (intentos >= 2) {
                    sesiones.delete(id);
                    captionFinal =
                        `❌ <b>RECARGA NO COMPLETADA: MONTO / FONDOS INSUFICIENTES</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `📱 <b>Línea:</b> <code>${numero}</code>\n` +
                        `💲 <b>Monto:</b> $${monto} MXN\n\n` +
                        `💡 <b>Motivo:</b> La segunda tarjeta no cuenta con fondos suficientes o fue rechazada por el banco.\n` +
                        `🔄 <b>Reiniciando proceso...</b> Toca /start para comenzar de nuevo:`;

                    if (captura) {
                        await ctx.replyWithPhoto({ source: captura }, {
                            caption: captionFinal.slice(0, 1024),
                            parse_mode: 'HTML'
                        });
                    } else {
                        await ctx.replyWithHTML(captionFinal);
                    }
                } else {
                    captionFinal =
                        `❌ <b>RECARGA NO COMPLETADA: MONTO / FONDOS INSUFICIENTES</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `📱 <b>Línea:</b> <code>${numero}</code>\n` +
                        `💲 <b>Monto:</b> $${monto} MXN\n\n` +
                        `💡 <b>Motivo:</b> La tarjeta no cuenta con el monto adecuado para realizar la recarga.\n\n` +
                        `👉 <b>Escribe tu nueva tarjeta para reintentar:</b>\n` +
                        `<code>16DÍGITOS|MM|AA|CVV</code>`;

                    if (captura) {
                        await ctx.replyWithPhoto({ source: captura }, {
                            caption: captionFinal.slice(0, 1024),
                            parse_mode: 'HTML'
                        });
                    } else {
                        await ctx.replyWithHTML(captionFinal);
                    }
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

                if (captura) {
                    await ctx.replyWithPhoto({ source: captura }, {
                        caption: captionFinal.slice(0, 1024),
                        parse_mode: 'HTML'
                    });
                } else {
                    await ctx.replyWithHTML(captionFinal);
                }

            } else {
                captionFinal =
                    (clasif.icono || '⚠️') + ` <b>` + clasif.titulo + `</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📱 <b>Línea:</b> <code>${numero}</code>\n` +
                    `💲 <b>Monto:</b> $${monto} MXN\n` +
                    `📄 <b>Detalle:</b> "<i>${fragmento}</i>"\n\n` +
                    `⚠️ ▫️ La recarga no fue aprobada.\n` +
                    `👉 <b>Toca /start para intentar de nuevo.</b>`;

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

            if (capturaError) {
                await ctx.replyWithPhoto({ source: capturaError }, {
                    caption: msgError.slice(0, 1024),
                    parse_mode: 'HTML'
                });
            } else {
                await ctx.replyWithHTML(msgError);
            }
        }
    } finally {
        await cerrarNavegadorBait(id);
    }
}


// ==============================================================================
// 🤖 7. INTERFAZ OFICIAL "BOT LEÓN" (BOTONES TEMPORALES Y AUTO-LIMPIEZA)
// ==============================================================================
async function mostrarMenuInicio(ctx, esReinicio = false) {
    const id = ctx.chat?.id || ctx.from?.id;
    await cerrarSesionNavegador(id);
    await cerrarNavegadorBait(id);
    await limpiarMensajesTemporales(ctx, id);
    sesiones.delete(id);

    const textoMenu = 
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🦁 <b>BOT LEÓN</b> 🤖\n` +
        `👋 ¡BIENVENIDO! Recargas veloces • 100% Seguras • Sin errores 📱💳\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🎯 <b>SELECCIONA COMPAÑÍA</b>\n` +
        `▫️▫️▫️ 🟢 <b>TELCEL</b> ▫️▫️▫️   ▫️▫️▫️ 🔵 <b>BAIT</b> ▫️▫️▫️\n\n` +
        `▫️🔄 <b>REINICIAR</b>   ▫️🛑 <b>CANCELAR</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💲 <b>MONTOS VÁLIDOS</b>\n` +
        `✅ <b>TELCEL:</b> ▫️$200 ▫️$300 ▫️$500\n` +
        `✅ <b>BAIT:</b> ▫️$200 ▫️$230 ▫️$300\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 <b>CÓMO FUNCIONA</b>\n` +
        `▫️ 1️⃣ Elige compañía\n` +
        `▫️ 2️⃣ Selecciona monto\n` +
        `▫️ 3️⃣ Número: 10 dígitos\n` +
        `▫️ 4️⃣ Tarjeta: 16DÍGITOS | MM | AA | CVV\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🧹 <b>LIMPIEZA AUTOMÁTICA</b>\n` +
        `▫️ Cada paso borra el anterior → Sin trabas • Sin confusiones\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👉 <b>TOCA UNA OPCIÓN PARA EMPEZAR:</b>`;

    const tecladoMenu = Markup.inlineKeyboard([
        [
            Markup.button.callback('🟢 TELCEL', 'btn_telcel'),
            Markup.button.callback('🔵 BAIT', 'btn_bait')
        ],
        [
            Markup.button.callback('🔄 REINICIAR', 'btn_reiniciar'),
            Markup.button.callback('🛑 CANCELAR', 'btn_cancelar')
        ]
    ]);

    const msg = await ctx.reply(textoMenu, { parse_mode: 'HTML', ...tecladoMenu });
    if (msg && msg.message_id) {
        registrarMensajeTemporal(id, msg.message_id);
    }
    return msg;
}

// 🛑 COMANDOS DE CONTROL
bot.command(['stop', 'cancelar', 'reset'], async ctx => {
    const id = ctx.chat?.id || ctx.from?.id;
    await cerrarSesionNavegador(id);
    await cerrarNavegadorBait(id);
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
    await mostrarMenuInicio(ctx, false);
});

bot.command('telcel', async ctx => {
    return iniciarCompania(ctx, 'Telcel');
});

bot.command('bait', async ctx => {
    return iniciarCompania(ctx, 'Bait');
});

// CALLBACKS DE BOTONES DEL MENÚ PRINCIPAL
bot.action('btn_telcel', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    return iniciarCompania(ctx, 'Telcel');
});

bot.action('btn_bait', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    return iniciarCompania(ctx, 'Bait');
});

bot.action('btn_reiniciar', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    return mostrarMenuInicio(ctx, true);
});

bot.action('btn_cancelar', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    const id = ctx.chat?.id || ctx.from?.id;
    await cerrarSesionNavegador(id);
    await cerrarNavegadorBait(id);
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
    } else {
        cerrarSesionNavegador(id);
    }

    sesiones.set(id, { 
        tipo: compania, 
        modo: compania.toLowerCase(), 
        paso: 'monto', 
        intentosTarjeta: 0 
    });

    const icono = compania === 'Bait' ? '🔵' : '🟢';
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
        s = { tipo: 'Bait', modo: 'bait', paso: 'monto', intentosTarjeta: 0 };
    }

    s.monto = valorMonto;
    s.paso = 'numero';
    s.numero = null;
    s.tarjeta = null;
    sesiones.set(id, s);

    const compania = s.tipo || 'Bait';
    const icono = compania === 'Bait' ? '🔵' : '🟢';

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

// ==============================================================================
// 📨 8. ROUTER DE MENSAJES Y PASOS POR TEXTO (INTERFAZ LIMPIA Y FLUIDA)
// ==============================================================================
bot.on('text', async (ctx, next) => {
    const id = ctx.chat?.id || ctx.from?.id;
    const txt = ctx.message.text.trim();

    if (txt.startsWith('/')) return next();

    let s = sesiones.get(id);

    // A. DETECCIÓN DE COMPAÑÍA EN TEXTO
    if (/^(telcel|bait)$/i.test(txt)) {
        const comp = txt.toLowerCase().includes('bait') ? 'Bait' : 'Telcel';
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
        if (s.tipo === 'Telcel' && ![200, 300, 500].includes(monto)) {
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
        const icono = compania === 'Bait' ? '🔵' : '🟢';

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

    // C. DETECCIÓN DE NÚMERO CELULAR (10 DÍGITOS EXACTOS)
    const soloDigitos = txt.replace(/\D/g, '');
    if (s.paso === 'numero' || (soloDigitos.length === 10 && !s.numero)) {
        if (soloDigitos.length !== 10) {
            return enviarLimpio(ctx,
                `⚠️ <b>NÚMERO INVÁLIDO</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `El número debe tener exactamente <b>10 dígitos numéricos</b>.\n` +
                `▫️ Ejemplo: <code>5512345678</code>\n\n` +
                `✍️ <b>Escribe el número nuevamente:</b> `,
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 REINICIAR', 'btn_reiniciar')]
                ])
            );
        }

        s.numero = soloDigitos;
        s.paso = 'tarjeta';
        sesiones.set(id, s);

        const compania = s.tipo || 'Telcel';
        const icono = compania === 'Bait' ? '🔵' : '🟢';

        return enviarLimpio(ctx,
            `${icono} <b>${compania.toUpperCase()} — PASO 3 DE 3</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `✅ <b>Número confirmado:</b> <code>${s.numero}</code>\n` +
            `💲 <b>Monto:</b> $${s.monto || 300} MXN\n\n` +
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

        if (s.modo === 'bait' || s.tipo === 'Bait') {
            flujoBait(ctx, id, s).catch(err => {
                console.error(`[Bait Usuario ${id}] Error:`, err.message || err);
            });
        } else {
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
    servidor.close(() => process.exit(0));
});

process.once('SIGTERM', async () => {
    try { await bot.stop('SIGTERM'); } catch(e) {}
    for (const [id] of navegadoresActivos) {
        await cerrarSesionNavegador(id);
    }
    await cerrarNavegadorBait();
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

    async function iniciarTelegramBot() {
        try {
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

iniciarServidorYBot();
