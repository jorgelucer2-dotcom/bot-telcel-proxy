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
const MAX_RETRIES_BAIT = 8;

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
        'div[role="dialog"]',
        'dialog[open]',
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

function clasificarResultadoBait(textoCompleto, id) {
    const esExito = /(éxito)|(exitosa)|(recarga\s*exitosa)|(pago\s*exitoso)|(folio:?)|(folio\s*\d+)|(comprobante)|(ticket)|(¡listo!)|(aprobada)|(aprobado)|(transacci[óo]n\s*exitosa)|(gracias\s*por\s*tu\s*compra)|(tu\s*pago\s*ha\s*sido\s*(exitoso|procesado|aprobado))|(tu\s*recarga\s*fue\s*exitosa)|(pago\s*realizado)|(operaci[óo]n\s*exitosa)/i.test(textoCompleto);

    if (esExito) {
        return {
            estado: 'EXITO',
            titulo: '🎉 ✅ RECARGA BAIT EXITOSA — PAGO APROBADO',
            subtipo: 'EXITOSO',
            icono: '✅',
            explicacion: 'La recarga fue procesada y aprobada exitosamente por Bait.'
        };
    }

    const esFondos = /(fondos\s*insuficientes)|(saldo\s*insuficiente)|(saldo\s*disponible)|(no\s*tiene\s*fondos)|(sin\s*fondos)|(monto\s*no\s*adecuado)|(monto\s*insuficiente)/i.test(textoCompleto);
    const esTarjeta = /(tarjeta\s*(inv[áa]lida|no\s*v[áa]lida|rechazada|no\s*soportada|no\s*aceptada|no\s*permitida))|(n[úu]mero\s*de\s*tarjeta\s*inv[áa]lido)|(cvv\s*incorrecto)|(fecha\s*de\s*vencimiento)|(vencimiento\s*inv[áa]lido)|(emisor\s*no\s*soportado)|(tipo\s*de\s*tarjeta\s*no\s*v[áa]lida)|(entidad\s*rechaz[óo])|(bloqueo\s*por\s*seguridad)|(l[íi]mite\s*diario)|(no\s*autorizada\s*por\s*el\s*banco)|(rechazada\s*por\s*el\s*banco)|(intenta\s*con\s*otra\s*tarjeta)|(intente\s*con\s*otra\s*tarjeta)|(intente\s*con\s*otra)|(consulte\s*con\s*el\s*emisor)|(comun[íi]quese\s*con\s*su\s*banco)|(banco\s*emisor)|(transacci[óo]n\s*no\s*autorizada)|(no\s*se\s*pudo\s*procesar\s*su\s*pago)|(no\s*se\s*pudo\s*completar\s*el\s*pago)|(lo\s*sentimos)/i.test(textoCompleto);

    if (esFondos) {
        return {
            estado: 'RECHAZO_BANCARIO',
            subtipo: 'FONDOS_INSUFICIENTES',
            titulo: '❌ RECARGA NO COMPLETADA: FONDOS / MONTO INSUFICIENTE',
            icono: '💸',
            explicacion: 'La tarjeta no cuenta con el monto o saldo adecuado para realizar la recarga.'
        };
    }

    if (esTarjeta) {
        return {
            estado: 'RECHAZO_BANCARIO',
            subtipo: 'TARJETA_DECLINADA',
            titulo: '❌ RECARGA NO COMPLETADA: TARJETA DECLINADA',
            icono: '💳',
            explicacion: 'El banco emisor declinó el cobro (fondos insuficientes o bloqueo).'
        };
    }

    const esGenerico = /(tu\s*solicitud\s*no\s*pudo\s*ser\s*(completada|procesada))|(no\s*se\s*pudo\s*realizar\s*(el\s*pago|la\s*operaci[óo]n))|(transacci[óo]n\s*rechazada)|(pago\s*rechazado)|(error\s*al\s*procesar)|(hubo\s*un\s*problema)|(no\s*autorizada)|(int[ée]ntalo\s*m[áa]s\s*tarde)|(no\s*pudimos\s*procesar)/i.test(textoCompleto);

    if (esGenerico) {
        return {
            estado: 'RECHAZO_BANCARIO',
            subtipo: 'PROBLEMA_BANCARIO',
            titulo: '❌ PROBLEMA AL PROCESAR: PAGO RECHAZADO',
            icono: '💳',
            explicacion: 'La transacción no pudo ser completada por falta de fondos o rechazo del banco.'
        };
    }

    return {
        estado: 'PAGO_ENVIADO',
        subtipo: 'DESPACHADO',
        titulo: '🚀 PAGO ENVIADO Y PROCESADO',
        icono: '🚀',
        explicacion: 'El botón de pago fue presionado exitosamente y la orden fue enviada.'
    };
}

function clasificarResultadoTelcel(textoCompleto, id) {
    const esExito = /(éxito)|(pago\s*exitoso)|(transacci[óo]n\s*exitosa)|(recarga\s*exitosa)|(¡listo!)|(folio:?)|(folio\s*\d+)|(comprobante)|(ticket)|(aprobada)|(aprobado)|(gracias\s*por\s*tu\s*compra)|(tu\s*pago\s*ha\s*sido\s*(exitoso|procesado|aprobado))|(tu\s*recarga\s*fue\s*exitosa)|(realizado)|(completado)|(recibo)|(pago\s*realizado)/i.test(textoCompleto);

    if (esExito) {
        return {
            estado: 'EXITO',
            titulo: '🎉 ✅ PAGO EXITOSO — RECARGA APLICADA',
            subtipo: 'EXITOSO',
            icono: '✅',
            explicacion: 'La recarga fue procesada y aprobada exitosamente por Telcel y el banco emisor.'
        };
    }

    const esFondos = /(fondos\s*insuficientes)|(saldo\s*insuficiente)|(saldo\s*disponible)|(no\s*tiene\s*fondos)|(sin\s*fondos)|(monto\s*insuficiente)/i.test(textoCompleto);
    const esTarjetaBanco = /(tarjeta\s*(inv[áa]lida|no\s*v[áa]lida|no\s*soportada|no\s*aceptada|no\s*reconocida|rechazada|no\s*permitida))|(n[úu]mero\s*de\s*tarjeta\s*inv[áa]lido)|(cvv\s*incorrecto)|(fecha\s*de\s*vencimiento)|(vencimiento\s*inv[áa]lido)|(emisor\s*no\s*soportado)|(tipo\s*de\s*tarjeta\s*no\s*v[áa]lida)|(revisa\s*el\s*n[úu]mero\s*de\s*tarjeta)|(bin\s*(inv[áa]lido|no\s*v[áa]lido|no\s*soportado))|(entidad\s*rechaz[óo])|(bloqueo\s*por\s*seguridad)|(l[íi]mite\s*diario)|(no\s*autorizada\s*por\s*el\s*banco)|(rechazada\s*por\s*el\s*banco)|(intenta\s*con\s*otra\s*tarjeta)/i.test(textoCompleto);

    if (esFondos) {
        return {
            estado: 'RECHAZO_BANCARIO',
            subtipo: 'FONDOS_INSUFICIENTES',
            titulo: '❌ RECARGA NO COMPLETADA: FONDOS INSUFICIENTES',
            icono: '💸',
            explicacion: 'El banco emisor declinó la transacción por falta de fondos o saldo disponible.'
        };
    }

    if (esTarjetaBanco) {
        return {
            estado: 'RECHAZO_BANCARIO',
            subtipo: 'TARJETA_O_DATOS',
            titulo: '❌ RECARGA NO COMPLETADA: TARJETA DECLINADA',
            icono: '💳',
            explicacion: 'El banco emisor o las validaciones de tarjeta rechazaron el cobro.'
        };
    }

    const esGenerico = /(tu\s*solicitud\s*no\s*pudo\s*ser\s*(completada|procesada))|(no\s*se\s*pudo\s*realizar\s*(el\s*pago|la\s*operaci[óo]n))|(transacci[óo]n\s*rechazada)|(pago\s*rechazado)|(error\s*al\s*procesar)|(hubo\s*un\s*problema)|(no\s*autorizada)|(int[ée]ntalo\s*m[áa]s\s*tarde)/i.test(textoCompleto);

    const historial = historialErroresUsuario.get(id) || [];
    const errorActualLimpio = textoCompleto.trim().replace(/\s+/g, ' ').slice(0, 100);
    const esRepetido = historial.some(e => e && e.length > 10 && errorActualLimpio.includes(e.slice(0, 30)));
    historial.push(errorActualLimpio);
    historialErroresUsuario.set(id, historial);

    if (esGenerico || esRepetido) {
        return {
            estado: 'BLOQUEO_TELCEL',
            subtipo: 'POSIBLE_LISTA_NEGRA',
            titulo: '⛔ POSIBLE BLOQUEO TELCEL / LISTA NEGRA',
            icono: '⛔',
            explicacion: 'Restricción de la plataforma Telcel por uso repetido, IP o filtro de riesgo.'
        };
    }

    return {
        estado: 'DESCONOCIDO',
        subtipo: 'ERROR_TEMPORAL',
        titulo: '⚠️ ERROR TEMPORAL / DESCONOCIDO',
        icono: '⚠️',
        explicacion: 'Respuesta no clasificada del portal.'
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

                ultimaEtapa = "Confirmación de pago";
                await pagina.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button'));
                    const b = btns.reverse().find(el => (el.innerText || '').includes('Continuar') || (el.innerText || '').includes('Pagar'));
                    if (b) { 
                        b.removeAttribute('disabled'); 
                        b.style.pointerEvents = 'auto'; 
                    }
                }).catch(() => {});

                const btnContinuar = pagina.locator('button[type="submit"].bg-\\[\\#7b1fa2\\]:has-text("Continuar"), button[type="submit"]:has-text("Continuar"), button:has-text("Continuar"), button:has-text("Pagar")').last();
                await btnContinuar.waitFor({ state: 'attached', timeout: 25000 });
                await btnContinuar.waitFor({ state: 'visible', timeout: 25000 });
                await btnContinuar.scrollIntoViewIfNeeded().catch(() => {});
                await btnContinuar.click({ force: true }).catch(() => {});

                const btnFisica = pagina.locator('button.ModalInvitation_buttonModal__42s7X, button:has-text("Continuar con mi tarjeta física"), button:has-text("tarjeta física")').first();
                if (await btnFisica.isVisible({ timeout: 4000 }).catch(() => false)) {
                    await btnFisica.scrollIntoViewIfNeeded().catch(() => {});
                    await btnFisica.click({ force: true }).catch(() => {});
                }

                ultimaEtapa = "Analizando respuesta y comprobante";
                await pagina.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

                const inicioEspera = Date.now();
                const TIEMPO_MAXIMO_ESPERA_MS = 60000;
                let textoFinalPagina = "";
                let clasificacionFinal = null;

                while (Date.now() - inicioEspera < TIEMPO_MAXIMO_ESPERA_MS) {
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
                        let fragmentos = [];
                        for (const sel of selectores) {
                            document.querySelectorAll(sel).forEach(el => {
                                const t = el.innerText || '';
                                if (t.trim().length > 0 && !fragmentos.includes(t.trim())) {
                                    fragmentos.push(t.trim());
                                }
                            });
                        }
                        return fragmentos.join(' \n ');
                    }).catch(() => '');

                    clasificacionFinal = clasificarResultadoTelcel(textoFinalPagina, id);

                    if (clasificacionFinal.estado === 'EXITO' || clasificacionFinal.estado === 'RECHAZO_BANCARIO' || clasificacionFinal.estado === 'BLOQUEO_TELCEL') {
                        break;
                    }

                    await pagina.waitForTimeout(1000);
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
            await ctx.replyWithPhoto({ source: mensajeErrorFinal }, {
                caption: mensajeErrorFinal.slice(0, 1024),
                parse_mode: 'HTML'
            });
        } else {
            await ctx.replyWithHTML(mensajeErrorFinal);
        }
    } finally {
        await cerrarSesionNavegador(id);
    }
}


// ==============================================================================
// 🔵 6. MÓDULO BAIT ($200, $230, $300) — ARQUITECTURA EN 3 ETAPAS INDEPENDIENTES
// ==============================================================================
const BAIT_SEL = {
  MODAL: 'dialog[open], div[role="dialog"]:has-text("Mi Bait")',
  TEL: 'app-o-input[formcontrolname="baitNumber"] input, input[name="phone"], input[placeholder*="teléfono" i], input[placeholder*="número" i]',
  CORREO: 'app-o-input[formcontrolname="email"] input, input[name="email"], input[placeholder*="Correo" i]',
  BOTON_AVANCE_NEGRO: [
    'button.bg-black:has-text("Siguiente")',
    'button:has-text("Siguiente")'
  ],
  BOTON_AVANCE_AMARILLO: [
    'button.ph-bait-ex-85__submit-proxy:has-text("Continuar al pago")',
    'button:has-text("CONTINUAR AL PAGO")',
    'button:has-text("Continuar al pago")',
    'button[aria-label*="Continuar" i]',
    'button:has-text("Continuar")'
  ],
  PASARELA_PAYPAL: 'iframe[name*="paypal" i], iframe[name*="zoid" i], iframe[src*="paypal" i], #paypal-button-container',
  // Selectores específicos de la opción de pago con tarjeta en PayPal:
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

const cerrarBait = async id => {
    if (id && popupsActivosBait.has(id)) {
        const popup = popupsActivosBait.get(id);
        popupsActivosBait.delete(id);
        if (popup && !popup.isClosed()) {
            popup.close().catch(() => {});
        }
    }
    if (id && navegadoresBait.has(id)) {
        const nav = navegadoresBait.get(id);
        navegadoresBait.delete(id);
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
        } catch {}
    } else if (!id) {
        popupsActivosBait.clear();
        const navs = Array.from(navegadoresBait.values());
        navegadoresBait.clear();
        for (const nav of navs) {
            try {
                nav.close().catch(() => {});
            } catch {}
        }
    }
    global.gc?.();
};

const lanzarMxBait = async id => {
    await cerrarBait(id);
    const geo = { latitude: 19.4326, longitude: -99.1332, accuracy: 100 };
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
    let nav, contexto, pag;

    const usarBrightData = !USE_LOCAL_CHROMIUM && Boolean(BRIGHTDATA_BROWSER_WS && (BRIGHTDATA_BROWSER_WS.startsWith('ws://') || BRIGHTDATA_BROWSER_WS.startsWith('wss://')));

    if (usarBrightData) {
        nav = await chromium.connectOverCDP(BRIGHTDATA_BROWSER_WS, { timeout: 35000 });
        contexto = nav.contexts()[0] || await nav.newContext({
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
        pag = contexto.pages()[0] || await contexto.newPage();
    } else {
        nav = await chromium.launch({ headless: ES_HEADLESS, slowMo: 0, timeout: 35000, args });
        contexto = await nav.newContext({
            locale: 'es-MX',
            timezoneId: 'America/Mexico_City',
            geolocation: geo,
            permissions: ['geolocation'],
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            extraHTTPHeaders: { 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8' }
        });
        await contexto.grantPermissions(['geolocation'], { origin: 'https://mibait.com' }).catch(() => {});
        pag = await contexto.newPage();
    }

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

    navegadoresBait.set(id, nav);
    return pag;
};

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

// ==============================================================================
// 🟢 PASO 1 — MODAL BAIT (Abrir paquete, detectar dialog[open], llenar datos y clic en avance)
// ==============================================================================
async function paso1ModalBait(pag, id, numero, correo, monto = 300) {
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
    await cardBtn.click();

    const modal = pag.locator('dialog[open]').first();
    await modal.waitFor({ state: 'visible', timeout: 15000 });
    console.log(`[Bait Usuario ${id}] 🟢 PASO 1: Modal abierto`);

    // Ingresar teléfono y correo
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
    console.log(`[Bait Usuario ${id}] 🟢 PASO 1: Teléfono y correo ingresados`);

    // Detección y clic en el botón de avance del modal
    const inicioEspera = Date.now();
    const TIMEOUT_AVANCE_MS = 15000;
    let btnEncontrado = null;

    while (Date.now() - inicioEspera < TIMEOUT_AVANCE_MS) {
        for (const sel of BAIT_SEL.BOTON_AVANCE_AMARILLO) {
            try {
                const b = modal.locator(sel).first();
                if (await b.isVisible({ timeout: 60 }).catch(() => false)) {
                    btnEncontrado = b;
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
                        break;
                    }
                } catch(e) {}
            }
        }

        if (btnEncontrado) {
            await btnEncontrado.scrollIntoViewIfNeeded().catch(() => {});
            await btnEncontrado.click({ force: true }).catch(async () => {
                await pag.evaluate(() => {
                    const b = document.querySelector('button.bg-black, button[type="submit"], button.ph-bait-ex-85__submit-proxy');
                    if (b) {
                        b.removeAttribute('disabled');
                        b.disabled = false;
                        b.click();
                    }
                }).catch(() => {});
            });
            console.log(`[Bait Usuario ${id}] 🟢 PASO 1: Botón de avance detectado y clickeado`);
            return true;
        }

        await pag.waitForTimeout(100);
    }

    throw new Error("FALLO_PASO_1: No se pudo habilitar o presionar el botón de avance del modal");
}

// ==============================================================================
// 🔍 🟢 PASO 2 — PASARELA PAYPAL (Esperar y detectar exclusivamente PayPal)
// ==============================================================================
async function paso2EsperarPasarelaPayPalBait(pag, id) {
    console.log(`[Bait Usuario ${id}] 🔍 PASO 2: Esperando pasarela PayPal...`);
    const inicio = Date.now();
    const TIMEOUT_PAYPAL_MS = 28000; // 28 segundos de espera activa
    let pasarelaPaypalDetectada = false;

    while (Date.now() - inicio < TIMEOUT_PAYPAL_MS) {
        // 1. Revisar descarte por Conekta en página principal
        const textoPrincipal = await pag.evaluate(() => (document.body ? document.body.innerText : '') || '').catch(() => '');
        if (/conekta/i.test(textoPrincipal) || /paga seguro con/i.test(textoPrincipal) || /efectivo en oxxo/i.test(textoPrincipal) || /spei/i.test(textoPrincipal)) {
            console.log(`[Bait Usuario ${id}] ⚡ Conekta detectada. Cierre y relanzamiento inmediato...`);
            throw new Error("PASARELA_NO_COMPATIBLE_CONEKTA");
        }

        // Contextos a revisar: página principal y popups activos
        const popup = popupsActivosBait.get(id);
        const paginasARevisar = [pag];
        if (popup && typeof popup.isClosed === 'function' && !popup.isClosed()) {
            paginasARevisar.push(popup);
        }

        // 2. 🔎 Revisando página principal y 🔎 Revisando popup
        for (const p of paginasARevisar) {
            const esPopup = p !== pag;
            const tag = esPopup ? 'popup' : 'página principal';

            // Evidencia A: URL de la página/popup
            const pUrl = (p.url() || '').toLowerCase();
            if (pUrl.includes('paypal')) {
                pasarelaPaypalDetectada = true;
                console.log(`[Bait Usuario ${id}] 🟢 PASO 2: PASARELA PAYPAL DETECTADA (en URL de ${tag}: ${pUrl.slice(0, 70)})`);
                console.log(`[Bait Usuario ${id}] ✅ PASO 2 COMPLETADO: PASARELA PAYPAL DETECTADA`);
                return { pasarelaPaypalDetectada: true };
            }

            // Evidencia B: Texto visible 'PayPal'
            const txt = await p.evaluate(() => (document.body ? document.body.innerText : '') || '').catch(() => '');
            if (/paypal/i.test(txt)) {
                pasarelaPaypalDetectada = true;
                console.log(`[Bait Usuario ${id}] 🟢 PASO 2: PASARELA PAYPAL DETECTADA (en texto visible de ${tag})`);
                console.log(`[Bait Usuario ${id}] ✅ PASO 2 COMPLETADO: PASARELA PAYPAL DETECTADA`);
                return { pasarelaPaypalDetectada: true };
            }

            // Evidencia C: Iframe cuyo src o name contenga 'paypal' o 'zoid'
            const iframeLocator = p.locator('iframe[name*="paypal" i], iframe[src*="paypal" i], iframe[name*="zoid" i], #paypal-button-container iframe').first();
            if (await iframeLocator.isVisible({ timeout: 60 }).catch(() => false) || await iframeLocator.count().catch(() => 0) > 0) {
                pasarelaPaypalDetectada = true;
                console.log(`[Bait Usuario ${id}] 🟢 PASO 2: PASARELA PAYPAL DETECTADA (en iframe del DOM de ${tag})`);
                console.log(`[Bait Usuario ${id}] ✅ PASO 2 COMPLETADO: PASARELA PAYPAL DETECTADA`);
                return { pasarelaPaypalDetectada: true };
            }

            // 3. 🔎 Revisando frames de esta página
            const frames = p.frames ? p.frames() : [];
            for (const f of frames) {
                const fUrl = (f.url() || '').toLowerCase();
                const fName = (f.name() || '').toLowerCase();

                if (fUrl.includes('paypal') || fName.includes('paypal') || fName.includes('zoid')) {
                    pasarelaPaypalDetectada = true;
                    console.log(`[Bait Usuario ${id}] 🟢 PASO 2: PASARELA PAYPAL DETECTADA (en frame: Name="${fName}", URL="${fUrl.slice(0, 60)}")`);
                    console.log(`[Bait Usuario ${id}] ✅ PASO 2 COMPLETADO: PASARELA PAYPAL DETECTADA`);
                    return { pasarelaPaypalDetectada: true };
                }
            }
        }

        await pag.waitForTimeout(250);
    }

    // 📊 Diagnóstico detallado si expira el tiempo sin detectar PayPal
    const popup = popupsActivosBait.get(id);
    const paginasActivas = pag.context() ? pag.context().pages() : [pag];
    const urlPag = pag.url() || 'desconocida';
    const numPags = paginasActivas.length;
    const listaFrames = pag.frames().map(f => ({ name: f.name(), url: f.url().slice(0, 80) }));
    const txtFinal = await pag.evaluate(() => (document.body ? document.body.innerText : '') || '').catch(() => '');
    const tieneTextoPayPal = /paypal/i.test(txtFinal);
    const tieneIframePayPal = (await pag.locator('iframe[name*="paypal" i], iframe[src*="paypal" i], iframe[name*="zoid" i]').count().catch(() => 0)) > 0;

    console.log("==================================================");
    console.log(`❌ [Bait Usuario ${id}] DIAGNÓSTICO FALLO PASO 2 (PayPal no detectado en 28s):`);
    console.log(`🌐 URL de pag: ${urlPag}`);
    console.log(`📄 Páginas abiertas en contexto: ${numPags}`);
    console.log(`🪟 Popup registrado: ${popup && !popup.isClosed() ? popup.url() : 'Ninguno'}`);
    console.log(`🖼️ Frames detectados (${listaFrames.length}):`, JSON.stringify(listaFrames, null, 2));
    console.log(`📝 ¿Texto PayPal visible?: ${tieneTextoPayPal ? 'SÍ' : 'NO'}`);
    console.log(`🔍 ¿Iframe PayPal en DOM?: ${tieneIframePayPal ? 'SÍ' : 'NO'}`);
    console.log("==================================================");

    throw new Error("FALLO_PASO_2_PAYPAL_NO_DETECTADO");
}

// ==============================================================================
// 💳 🔍 PASO 3 — ELEMENTOS POSTERIORES (Ejecuta SOLO si PASO 2 confirmó PayPal)
// ==============================================================================
async function paso3DiagnosticarEntornoBait(pag, id) {
    const popup = popupsActivosBait.get(id);
    const target = (popup && !popup.isClosed()) ? popup : pag;
    const url = target.url() || '';
    const titulo = await target.title().catch(() => '');
    const frames = target.frames ? target.frames() : [];

    console.log("--------------------------------------------------");
    console.log(`📊 [Diagnóstico PASO 3] URL: ${url} | Título: "${titulo}" | Cantidad Frames: ${frames.length}`);

    // Elementos en documento principal
    const interactivosPrincipal = await target.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, [role="button"], [role="link"], div[data-funding-source], a'));
        return els.map(e => ({
            tag: e.tagName,
            role: e.getAttribute('role'),
            funding: e.getAttribute('data-funding-source'),
            aria: e.getAttribute('aria-label'),
            text: (e.innerText || '').trim().slice(0, 35)
        })).filter(e => e.funding || e.aria || e.text);
    }).catch(() => []);
    console.log(`📌 Elementos en Documento Principal (${interactivosPrincipal.length}):`, JSON.stringify(interactivosPrincipal.slice(0, 5)));

    // Elementos en cada iframe
    for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (f === target) continue;
        const interactivosFrame = await f.evaluate(() => {
            const els = Array.from(document.querySelectorAll('button, [role="button"], [role="link"], div[data-funding-source], a'));
            return els.map(e => ({
                tag: e.tagName,
                role: e.getAttribute('role'),
                funding: e.getAttribute('data-funding-source'),
                aria: e.getAttribute('aria-label'),
                text: (e.innerText || '').trim().slice(0, 35)
            })).filter(e => e.funding || e.aria || e.text);
        }).catch(() => []);
        if (interactivosFrame.length > 0) {
            console.log(`🖼️ Elementos en Frame [${i}] "${f.name()}" (${interactivosFrame.length}):`, JSON.stringify(interactivosFrame.slice(0, 5)));
        }
    }
    console.log("--------------------------------------------------");
}

async function paso3HacerClicTarjetaBait(pag, id) {
    console.log(`[Bait Usuario ${id}] 🔍 PASO 3: Analizando elementos posteriores...`);
    const inicio = Date.now();
    const TIMEOUT_TARJETA_MS = 25000;
    let clickRealizado = false;
    let diagnosticoMostrado = false;

    while (Date.now() - inicio < TIMEOUT_TARJETA_MS) {
        const popup = popupsActivosBait.get(id);
        const targetContext = (popup && !popup.isClosed()) ? popup : pag;
        const frames = targetContext.frames ? targetContext.frames() : [targetContext];

        // 1. Revisar frames individualmente
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

        // Si tarda más de 3s en aparecer, emitir mensaje y diagnóstico sin reiniciar
        if (Date.now() - inicio > 3000 && !diagnosticoMostrado) {
            console.log(`[Bait Usuario ${id}] ℹ️ PayPal confirmado. El elemento posterior todavía no está disponible. NO REINICIAR.`);
            await paso3DiagnosticarEntornoBait(pag, id);
            diagnosticoMostrado = true;
        }

        await pag.waitForTimeout(250);
    }

    if (!clickRealizado) {
        console.log(`[Bait Usuario ${id}] ⚠️ El botón de tarjeta no respondió dentro del tiempo inicial. Conservando contexto para reintentos.`);
        await paso3DiagnosticarEntornoBait(pag, id);
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

    // Respaldo DOM en iframes y popup
    for (const ctx of contextosPrioritarios) {
        await ctx.evaluate(({ nom, ape, cp, calle, ciudad, estado }) => {
            document.querySelectorAll('div, fieldset').forEach(container => {
                const label = container.querySelector('label');
                const input = container.querySelector('input');
                if (label && input) {
                    const txt = (label.innerText || '').toLowerCase().trim();
                    if (txt.includes('nombre') && !txt.includes('contacto') && !input.value) {
                        input.value = nom;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if ((txt.includes('apellido') || txt.includes('apellidos')) && !txt.includes('contacto') && !input.value) {
                        input.value = ape;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (txt.includes('postal') && !input.value) {
                        input.value = cp;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (txt.includes('direcci') && !input.value) {
                        input.value = calle;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (txt.includes('ciudad') && !input.value) {
                        input.value = ciudad;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
            });
        }, { nom: nomTexto, ape: apeTexto, cp: cpGenerado, calle: dirInfo.calle, ciudad: dirInfo.ciudad, estado: dirInfo.estado }).catch(() => {});
    }

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

    if (!consentChecked) {
        for (const ctx of contextosPrioritarios) {
            consentChecked = await ctx.evaluate(() => {
                const cb = document.querySelector('input[name="consent-checkbox"], input[type="checkbox"]');
                if (cb) {
                    cb.checked = true;
                    cb.dispatchEvent(new Event('input', { bubbles: true }));
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
                return false;
            }).catch(() => false);
            if (consentChecked) break;
        }
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

    if (!clickPagar) {
        for (const ctx of contextosPrioritarios) {
            try {
                clickPagar = await ctx.evaluate(() => {
                    const btn = document.querySelector('button#submit-button, button.css-aezqgw-button-Button, button[id*="submit"], button[type="submit"]');
                    if (btn) {
                        btn.click();
                        return true;
                    }
                    return false;
                }).catch(() => false);
                if (clickPagar) break;
            } catch(e) {}
        }
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
            await pag.evaluate(() => {
                document.querySelectorAll('input[type="checkbox"]').forEach(c => {
                    c.checked = true;
                    c.dispatchEvent(new Event('input', { bubbles: true }));
                    c.dispatchEvent(new Event('change', { bubbles: true }));
                });
            }).catch(() => {});
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

    await pag.waitForLoadState('networkidle', { timeout: 40000 }).catch(() => {});

    let textoFinalPagina = "";
    let clasificacionFinal = null;
    const inicioEsperaRespuesta = Date.now();
    const TIEMPO_ESPERA_RESPUESTA_MS = 40000;

    while (Date.now() - inicioEsperaRespuesta < TIEMPO_ESPERA_RESPUESTA_MS) {
        textoFinalPagina = await pag.evaluate(() => {
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
                'main',
                'body'
            ];
            let fragmentos = [];
            for (const sel of selectores) {
                document.querySelectorAll(sel).forEach(el => {
                    const t = el.innerText || '';
                    if (t.trim().length > 0 && !fragmentos.includes(t.trim())) {
                        fragmentos.push(t.trim());
                    }
                });
            }
            return fragmentos.join(' \n ');
        }).catch(() => '');

        clasificacionFinal = clasificarResultadoBait(textoFinalPagina, id);

        if (clasificacionFinal.estado === 'EXITO' || clasificacionFinal.estado === 'RECHAZO_BANCARIO' || clasificacionFinal.estado === 'ERROR_PASARELA') {
            break;
        }

        await pag.waitForTimeout(1000);
    }

    if (!clasificacionFinal) {
        clasificacionFinal = clasificarResultadoBait(textoFinalPagina, id);
    }

    return {
        exito: true,
        botonPagarAhoraClickeado,
        clasificacion: clasificacionFinal,
        textoLeido: extraerFragmentoClave(textoFinalPagina)
    };
}

// ==============================================================================
// 🔄 GESTOR DE INTENTOS Y POLÍTICA DE REINTENTO ESTRICTA DE BAIT
// ==============================================================================
async function ejecutarIntentoBait(ctx, id, datos, intento) {
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

    let pag = null;

    try {
        pag = await lanzarMxBait(id);

        // PASO 1: Modal Bait (Apertura, llenado y avance)
        await paso1ModalBait(pag, id, numero, correoDinamico, monto);

        // PASO 2: Pasarela PayPal (Detección exclusiva y confirmación)
        const estadoPaso2 = await paso2EsperarPasarelaPayPalBait(pag, id);

        // PASO 3: Elementos Posteriores (Solo tras confirmar PASO 2 exitoso)
        if (estadoPaso2 && estadoPaso2.pasarelaPaypalDetectada) {
            await paso3HacerClicTarjetaBait(pag, id);
            await paso3LlenarTarjetaYConfirmarBait(pag, id, datosCompletos);
            const resultadoFinalBait = await paso3ConfirmarTerminosYPagarAhoraBait(pag, id, monto);
            return { exito: true, pag, datos: datosCompletos, resultado: resultadoFinalBait };
        }

        throw new Error("FALLO_PASO_2_NO_CONFIRMADO");

    } catch (err) {
        let capturaError = null;
        if (pag && !pag.isClosed()) {
            capturaError = await tomarCapturaEnfocada(pag);
        }
        await cerrarBait(id);
        return { exito: false, pag: null, error: err, captura: capturaError };
    }
}

async function flujoBait(ctx, id, datos) {
    const { numero, monto: montoIn } = datos;
    const monto = montoIn || 300;

    await enviarLimpio(ctx,
        `🦁 <b>BOT LEÓN — PROCESANDO BAIT</b> 🤖\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📱 <b>Línea:</b> <code>${numero}</code>\n` +
        `💲 <b>Monto:</b> $${monto} MXN\n\n` +
        `⏳ ▫️ Conectando con la pasarela de pago...\n` +
        `▫️ No cierres esta ventana.`
    );

    let resultadoFinal = null;

    for (let intento = 1; intento <= MAX_RETRIES_BAIT; intento++) {
        resultadoFinal = await ejecutarIntentoBait(ctx, id, datos, intento);
        if (resultadoFinal && resultadoFinal.exito && resultadoFinal.pag) {
            break;
        }
        await cerrarBait(id);
    }

    if (resultadoFinal && resultadoFinal.exito && resultadoFinal.pag) {
        const pag = resultadoFinal.pag;
        const info = resultadoFinal.resultado || {};
        const clasif = info.clasificacion || { estado: 'PAGO_ENVIADO', titulo: '🚀 PAGO ENVIADO', explicacion: 'Orden procesada.' };
        const fragmento = info.textoLeido || 'Pago enviado';
        
        const captura = await tomarCapturaEnfocada(pag);

        await limpiarMensajesTemporales(ctx, id);

        let captionFinal = '';

        if (clasif.estado === 'EXITO') {
            captionFinal =
                `🦁 <b>BOT LEÓN — COMPROBANTE DE RECARGA EXITOSA</b> ✅\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `📱 <b>Línea:</b> <code>${numero}</code>\n` +
                `💲 <b>Monto:</b> $${monto} MXN\n` +
                `✅ <b>Estado:</b> Recarga acreditada con éxito\n` +
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

        } else {
            captionFinal =
                (clasif.icono || '📄') + ` <b>` + clasif.titulo + `</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `📱 <b>Línea:</b> <code>${numero}</code>\n` +
                `💲 <b>Monto:</b> $${monto} MXN\n` +
                `📄 <b>Estado:</b> "<i>${fragmento}</i>"\n\n` +
                `👉 <b>Toca /start para realizar otra recarga.</b>`;

            if (captura) {
                await ctx.replyWithPhoto({ source: captura }, {
                    caption: captionFinal.slice(0, 1024),
                    parse_mode: 'HTML'
                });
            } else {
                await ctx.replyWithHTML(captionFinal);
            }
        }

        await cerrarBait(id);

    } else {
        const capturaError = resultadoFinal?.captura;
        await cerrarBait(id);
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
}


// ==============================================================================
// 🤖 7. INTERFAZ OFICIAL "BOT LEÓN" (BOTONES TEMPORALES Y AUTO-LIMPIEZA)
// ==============================================================================
async function mostrarMenuInicio(ctx, esReinicio = false) {
    const id = ctx.chat?.id || ctx.from?.id;
    await cerrarSesionNavegador(id);
    await cerrarBait(id);
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
    await cerrarBait(id);
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
    await cerrarBait(id);
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
        cerrarBait(id);
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
    await cerrarBait();
    servidor.close(() => process.exit(0));
});

process.once('SIGTERM', async () => {
    try { await bot.stop('SIGTERM'); } catch(e) {}
    for (const [id] of navegadoresActivos) {
        await cerrarSesionNavegador(id);
    }
    await cerrarBait();
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
