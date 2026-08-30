'use strict';

const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const { Telegraf, Markup } = require('telegraf');
const { chromium } = require('playwright');
require('dotenv').config();

// 📡 VARIABLES DE ENTORNO Y CONFIGURACIÓN (Render y PC)
const PUERTO = process.env.PORT || 3000;
const ES_HEADLESS = process.env.RENDER === 'true' || process.env.HEADLESS === 'true' || (process.platform === 'linux' && process.env.HEADLESS !== 'false');

const BOT_TOKEN = process.env.BOT_TOKEN || '8848937586:AAF5ARZdluPDkxtxhmtoay8v7QVD7wTXQ4E';
const URL_TELCEL = process.env.URL_TELCEL || 'https://pay.telcel.com/package/1';
const URL_NETFLIX = process.env.URL_NETFLIX || 'https://netflix.com/mx/';
const MONTO_TELCEL = 200;
const TIEMPO_MAX_COMANDO = 240000; // 4 minutos límite por proceso para evitar cuelgues
const MAX_USUARIOS = 8;

const bot = new Telegraf(BOT_TOKEN);

// --------------------------------------------------
// 🛡️ PROTECCIÓN GLOBAL CONTRA CAÍDAS DE NODE.JS
// --------------------------------------------------
process.on('uncaughtException', err => {
    console.error('💥 Excepción no controlada (Bot sigue vivo):', (err.message || err).toString().slice(0, 140));
});

process.on('unhandledRejection', err => {
    console.error('💥 Promesa rechazada (Bot sigue vivo):', (err.message || err).toString().slice(0, 140));
});

async function limpiarRecursosTotales() {
    for (const [uid, nav] of navegadoresActivos.entries()) {
        try {
            await nav.close().catch(() => {});
        } catch(e) {}
    }
    navegadoresActivos.clear();
}

// Mapas independientes por usuario (Multi-usuario real con aislamiento total)
const sesiones = { recarga: new Map(), netflix: new Map() };
const sesionesUsuario = sesiones.netflix; // Alias para compatibilidad con flujo Netflix
const navegadoresActivos = new Map();
const ejecucionesUsuario = new Map();

// 🧹 Verificar cupo concurrente (Máximo 8)
function tieneCupo(id) {
    if (navegadoresActivos.has(id) || sesiones.recarga.has(id) || sesiones.netflix.has(id)) {
        return true;
    }
    if (navegadoresActivos.size >= MAX_USUARIOS) {
        return false;
    }
    return true;
}

function reiniciarUsuario(id, ctx) {
    liberarUsuario(id, ctx);
}

// --------------------------------------------------
// 🛡️ LIBERADOR Y RESTAURADOR UNIVERSAL DE USUARIOS
// --------------------------------------------------
async function liberarUsuario(id, ctx) {
    if (!id) return;

    // 1. Cerrar y destruir cualquier navegador / proceso activo del usuario
    if (navegadoresActivos.has(id)) {
        const nav = navegadoresActivos.get(id);
        try {
            if (nav && typeof nav.close === 'function') {
                await nav.close().catch(() => {});
            }
        } catch(e) {}
        navegadoresActivos.delete(id);
    }

    // 2. Limpiar todos los mapas y estados de memoria del usuario
    if (sesiones.recarga) sesiones.recarga.delete(id);
    if (sesiones.netflix) sesiones.netflix.delete(id);
    sesionesUsuario.delete(id);
    ejecucionesUsuario.delete(id);

    console.log(`[Usuario ${id}] 🔓 Sesión y procesos liberados al 100%.`);
}

function resetearSesionUsuario(ctx, id) {
    liberarUsuario(id, ctx);
}

// --------------------------------------------------
// 🛡️ CAPTURADOR GLOBAL DE ERRORES DE TELEGRAF (BOT NUNCA SE TRABA)
// --------------------------------------------------
bot.catch(async (err, ctx) => {
    const id = ctx.from?.id || ctx.chat?.id;
    console.error(`💥 [Error Global Telegraf - Usuario ${id}]:`, (err.message || err).toString().slice(0, 150));
    if (id) {
        await liberarUsuario(id, ctx);
        await ctx.reply("⚠️ Ocurrió un error y el bot se ha restaurado automáticamente.\n👉 Puedes escribir /recarga o /start para continuar.").catch(() => {});
    }
});

// --------------------------------------------------
// 🛡️ MIDDLEWARE GLOBAL: TIMEOUT Y CONTROL DE ERRORES POR USUARIO
// --------------------------------------------------
bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id) return next();

    try {
        await Promise.race([
            next(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('⌛ Tiempo límite excedido. Proceso cancelado por seguridad.')), TIEMPO_MAX_COMANDO)
            )
        ]);
    } catch (errorGlobal) {
        console.error(`[Usuario ${id}] ❌ Error capturado en Middleware:`, errorGlobal.message || errorGlobal);
        await liberarUsuario(id, ctx);

        if (errorGlobal.message !== "PROCESO_REINICIADO") {
            await ctx.reply(
                "⚠️ OCURRIÓ UN INCONVENIENTE EN EL PROCESO\n\n" +
                `🔎 Detalle: ${(errorGlobal.message || 'Error inesperado').slice(0, 110)}\n\n` +
                "✅ EL BOT HA SIDO LIBERADO → Puedes intentar nuevamente con /recarga o /start",
                Markup.removeKeyboard()
            ).catch(() => {});
        }
    }
});

async function esperar(ms, usuarioId, miId, paginaRef) {
    const inicio = Date.now();
    while (Date.now() - inicio < ms) {
        if (usuarioId && miId && ejecucionesUsuario.get(usuarioId) !== miId) {
            throw new Error("PROCESO_REINICIADO");
        }
        if (paginaRef && typeof paginaRef.isClosed === 'function' && paginaRef.isClosed()) {
            throw new Error("NAVEGADOR_CERRADO_MANUALMENTE");
        }
        await new Promise(r => setTimeout(r, Math.min(150, ms)));
    }
}

function aleatorio(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ==================================
// 🎲 GENERADORES DE DATOS
// ==================================
// 1. Listas de nombres y apellidos (SIN ACENTOS NI SIGNOS)
const nombres = [
  "Carlos", "Maria", "Juan", "Ana", "Luis", "Sofia", "Pedro", "Lucia",
  "Jorge", "Fernanda", "Miguel", "Alejandra", "Roberto", "Laura", "Daniel", "Valeria"
];
const apellidos = [
  "Garcia", "Martinez", "Lopez", "Hernandez", "Perez", "Rodriguez",
  "Sanchez", "Diaz", "Ramirez", "Cruz", "Torres", "Flores", "Gomez", "Vazquez"
];

// Función para limpiar cualquier signo, tilde o carácter especial
function limpiarTexto(str) {
  if (!str) return '';
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z\s]/g, "")
    .trim();
}

// 2. Función que devuelve nombre completo al azar (100% limpio)
function generarNombreAleatorio() {
  const nom = nombres[Math.floor(Math.random() * nombres.length)];
  const ape = apellidos[Math.floor(Math.random() * apellidos.length)];
  return limpiarTexto(`${nom} ${ape}`);
}

const nombresTelcel = nombres;
const apellidosTelcel = apellidos;
function generarNombre() { return limpiarTexto(nombres[Math.floor(Math.random() * nombres.length)]); }
function generarApellido() { return limpiarTexto(apellidos[Math.floor(Math.random() * apellidos.length)]); }
function generarNombreCompleto() { return generarNombreAleatorio(); }

const dominiosCorreo = ["gmail.com","outlook.com","yahoo.com","proton.me","hotmail.com","icloud.com"];
const caracteresPass = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*";

function generarCorreo() {
    const nombre = nombresTelcel[aleatorio(0, nombresTelcel.length - 1)].toLowerCase();
    const sufijo = Date.now().toString().slice(-4) + aleatorio(100, 999);
    const dominio = dominiosCorreo[aleatorio(0, dominiosCorreo.length - 1)];
    return `${nombre}${sufijo}@${dominio}`;
}

function generarContrasena() {
    return Array.from({ length: 12 }, () => caracteresPass[Math.floor(Math.random() * caracteresPass.length)]).join('');
}

// 📌 MENÚ PRINCIPAL MULTIUSUARIO
bot.start(ctx => {
    const id = ctx.from.id;
    sesionesUsuario.set(id, { paso: 'menu', modo: 'auto', correo: null, pass: null });

    ctx.reply(
        `👋 BOT SERVICIOS\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📱 /recarga → Recarga Telcel $${MONTO_TELCEL}\n` +
        `✅ Genera: Nombre\n` +
        `💳 Tú das: Número | Tarjeta | Fecha | CVV\n\n` +
        `🎬 /netflix → Crear Cuenta\n` +
        `✅ Opción: 🎲 Automática o ✍️ Tú pones datos\n` +
        `━━━━━━━━━━━━━━━━━━`,
        Markup.keyboard([
            ['🎲 Automático', '✍️ Manual', '📱 Recarga Telcel $200']
        ]).resize()
    );
});

// Botón 📱 Recarga Telcel $200
bot.hears(['📱 Recarga Telcel $200', 'Recarga Telcel', 'recarga telcel'], ctx => {
    const id = ctx.from.id;
    sesionesUsuario.set(id, { paso: 'esperando_numero_telcel' });
    ctx.reply(
        `💰 RECARGA TELCEL $${MONTO_TELCEL} MXN 💰\n\n` +
        `📲 Por favor, escribe tu NÚMERO TELCEL a 10 dígitos:\n` +
        `Ejemplo: 5512345678`,
        Markup.removeKeyboard()
    );
});

// Botón 🎲 Automático
bot.hears(['🎲 Automático', 'Automático', 'automatico'], ctx => {
    const id = ctx.from.id;
    sesionesUsuario.set(id, { modo: 'auto', paso: 'esperando_tarjeta', correo: null, pass: null });
    ctx.reply(
        "🎲 MODO AUTOMÁTICO ACTIVADO\n\n" +
        "El bot generará el correo, contraseña y nombre aleatoriamente.\n\n" +
        "📌 Envía tus datos en este formato:\n" +
        "👉 /crear TARJETA|MM|AAAA|CVV\n\n" +
        "Ejemplo:\n" +
        "4111111111111111|12|2028|123",
        Markup.removeKeyboard()
    );
});

// Botón ✍️ Manual (Paso a paso interactivo)
bot.hears(['✍️ Manual', 'Manual', 'manual'], ctx => {
    const id = ctx.from.id;
    sesionesUsuario.set(id, { modo: 'manual', paso: 'esperando_correo', correo: null, pass: null });
    ctx.reply(
        "✍️ MODO MANUAL ACTIVADO\n\n" +
        "📝 Por favor, escribe el CORREO ELECTRÓNICO que deseas usar:",
        Markup.removeKeyboard()
    );
});

// Botón 🟢 Sí, crear otra
bot.hears(['🟢 Sí, crear otra', 'Sí, crear otra', 'Si', 'Sí', 'si', 'sí'], ctx => {
    const id = ctx.from.id;
    sesionesUsuario.set(id, { paso: 'menu', modo: 'auto', correo: null, pass: null });
    ctx.reply(
        '🤖 SELECCIONA CÓMO QUIERES EMPEZAR:\n\n' +
        '1️⃣ 🎲 AUTOMÁTICO → Genera correo y contraseña\n' +
        '2️⃣ ✍️ MANUAL → Tú pones tus datos\n\n' +
        '👇 ELIGE UNA OPCIÓN:',
        Markup.keyboard([
            ['🎲 Automático', '✍️ Manual']
        ]).resize()
    );
});

// Botón 🔴 No, terminar
bot.hears(['🔴 No, terminar', 'No, terminar', 'No', 'no'], ctx => {
    const id = ctx.from.id;
    if (navegadoresActivos.has(id)) {
        try {
            navegadoresActivos.get(id).close().catch(() => {});
        } catch(e) {}
        navegadoresActivos.delete(id);
    }
    sesionesUsuario.delete(id);
    ctx.reply(
        '👋 PROCESO FINALIZADO POR COMPLETO\n\n' +
        '✅ Todos los recursos han sido liberados.\n' +
        '📌 Cuando gustes volver a usar el bot, simplemente escribe /start',
        Markup.removeKeyboard()
    );
});

// Listener de mensajes de texto: TELCEL PRIMERO Y EXCLUSIVO
bot.on('text', async (ctx, next) => {
    const id = ctx.chat.id;
    const txt = ctx.message.text.trim();

    if (txt.startsWith('/')) {
        return next();
    }

    // ✅ PRIMERO: SI ESTÁS EN RECARGA, NO EXISTE NETFLIX (PRIORIDAD TOTAL)
    if (sesiones.recarga.has(id)) {
        const estado = sesiones.recarga.get(id);

        // PASO 1: RECIBIR NÚMERO
        if (estado.paso === 1 || estado.paso === 'numero' || estado.paso === 'esperando_numero_telcel') {
            if (!/^\d{10}$/.test(txt)) {
                await ctx.reply("❌ No son 10 dígitos. Intenta de nuevo:");
                return;
            }
            // ✅ ACTUALIZA ESTADO: PASO 2 = TARJETA
            sesiones.recarga.set(id, { paso: 2, numero: txt });
            await ctx.reply(
                `✅ NÚMERO RECIBIDO: ${txt}\n` +
                `💳 AHORA TARJETA:\n` +
                `Formato: 16DÍGITOS|MM|AAAA|CVV\n` +
                `Ejemplo: 4111111111111111|08|2027|123`
            );
            return;
        }

        // PASO 2: RECIBIR TARJETA
        if (estado.paso === 2 || estado.paso === 'tarjeta' || estado.paso === 'esperando_tarjeta_telcel') {
            const partes = txt.split('|').map(p => p.trim());
            if (partes.length !== 4) {
                await ctx.reply(
                    "❌ Formato inválido.\n" +
                    "📌 Usa el formato: 16DÍGITOS|MM|AAAA|CVV\n" +
                    "Ejemplo: 4111111111111111|08|2027|123\n\n" +
                    "👉 Intenta de nuevo o escribe /recarga para reiniciar."
                );
                return;
            }
            const [cc, mes, anioCompleto, cvv] = partes;
            if (!cc || !mes || !anioCompleto || !cvv) {
                await ctx.reply(
                    "❌ Faltan datos en la tarjeta.\n" +
                    "📌 Formato: 16DÍGITOS|MM|AAAA|CVV\n" +
                    "👉 Intenta de nuevo:"
                );
                return;
            }
            const anio = (anioCompleto || '').slice(-2);
            const numero = estado.numero;
            const nombre = generarNombreCompleto();

            // ✅ GUARDA TODO EN SESIÓN EXCLUSIVA DE ESTE USUARIO
            sesiones.recarga.set(id, { numero, cc, mes, aa: anio, anio, cvv, nombre });

            await ctx.reply(
                `✅ CONFIRMACIÓN\n` +
                `━━━━━━━━━━━━━━━━\n` +
                `💰 MONTO: $${MONTO_TELCEL}\n` +
                `📱 NÚMERO: ${numero}\n` +
                `👤 TITULAR: ${nombre}\n` +
                `💳 TARJETA: ****${cc.slice(-4)}\n` +
                `📅 FECHA: ${mes}/${anio}\n` +
                `🔒 CVV: ***\n` +
                `━━━━━━━━━━━━━━━━\n` +
                `¿TODO CORRECTO?`,
                Markup.inlineKeyboard([
                    [Markup.button.callback("✅ INICIAR", "ok")],
                    [Markup.button.callback("❌", "no")]
                ])
            );
            return;
        }
        return;
    }

    // 🎬 NETFLIX: SOLO SI NO HAY RECARGA ACTIVA
    if (sesiones.netflix.has(id)) {
        const estado = sesiones.netflix.get(id);
        if (estado.paso === 'correo' || estado.paso === 'pedirCorreoPersonal' || estado.paso === 'esperando_correo') {
            estado.correo = txt;
            estado.paso = 'pass';
            sesiones.netflix.set(id, estado);
            await ctx.reply("🔑 CONTRASEÑA:");
            return;
        } else if (estado.paso === 'pass' || estado.paso === 'pedirPassPersonal' || estado.paso === 'esperando_pass') {
            estado.pass = txt;
            estado.paso = 'tarjeta';
            sesiones.netflix.set(id, estado);
            const { correo, pass } = estado;
            await ctx.reply(
                `✅ DATOS NETFLIX\n` +
                `━━━━━━━━━━━━━━━━\n` +
                `📧 ${correo}\n` +
                `🔑 ${pass}\n` +
                `━━━━━━━━━━━━━━━━\n\n` +
                `💳 Ahora envía tus datos de tarjeta:\n` +
                `👉 /crear TARJETA|MM|AAAA|CVV\n` +
                `Ej: 4111111111111111|12|2028|123`
            );
            return;
        }
    }

    // Envío directo de tarjeta con formato de pipes (ej. 4111...|12|2028|123)
    if (/^\d{15,16}\|/.test(txt)) {
        return procesarTextoTarjeta(ctx, txt);
    }

    return next();
});

// 🛑 PARO TOTAL / RESET INDEPENDIENTE POR USUARIO
bot.command(['reset', 'paro', 'parototal', 'stop', 'cancelar', 'kill', 'limpiar'], async ctx => {
    const id = ctx.from?.id || ctx.chat?.id;
    await liberarUsuario(id, ctx);

    await ctx.reply(
        "🛑 PROCESO CANCELADO Y LIBERADO\n\n" +
        "✅ Tu navegador ha sido cerrado y tu sesión reiniciada al 100%.\n" +
        "📌 Escribe /recarga o /start para comenzar de nuevo.",
        Markup.removeKeyboard()
    );
});

// 🔄 REINICIAR CON LA ÚLTIMA TARJETA DEL USUARIO
bot.command(['reiniciar', 'reintentar'], async ctx => {
    const id = ctx.from?.id || ctx.chat?.id;
    const s = sesionesUsuario.get(id);

    if (!s || !s.ultimaTarjeta) {
        return ctx.reply("⚠️ No tienes datos de tarjeta previos para reiniciar.\n📌 Envía: /crear TARJETA|MM|AAAA|CVV");
    }

    await ctx.reply("🔄 REINICIANDO TU REGISTRO DESDE CERO...");
    await iniciarProcesoUsuario(ctx, s.ultimaTarjeta, id);
});

// ==================================================
// 📱 RECARGA: INICIO Y LIMPIEZA
// ==================================================
bot.command(['recarga', 'telcel'], async ctx => {
    const id = ctx.chat?.id || ctx.from?.id;
    if (!tieneCupo(id)) {
        return ctx.reply("❌ Servidor ocupado (8/8 procesos concurrentes).\n⏳ Por favor espera unos momentos e intenta de nuevo.");
    }
    await liberarUsuario(id, ctx); // Proactivamente libera cualquier proceso o navegador anterior
    sesiones.recarga.set(id, { paso: 1 }); // Paso 1 = Número

    const texto = ctx.message.text.trim();
    const args = texto.substring(texto.indexOf(' ') + 1).trim();

    // Si envía todo en una línea: /recarga 5512345678 4111111111111111|12|2028|123
    const partesArgs = args.split(/\s+/);
    if (partesArgs.length === 2 && /^\d{10}$/.test(partesArgs[0]) && partesArgs[1].includes('|')) {
        const numero = partesArgs[0];
        const partesTarjeta = partesArgs[1].split('|');
        if (partesTarjeta.length === 4) {
            const [cc, mes, anioCompleto, cvv] = partesTarjeta.map(d => d.trim());
            const anio = anioCompleto.slice(-2);
            const nombre = generarNombreCompleto();

            sesiones.recarga.set(id, { numero, cc, mes, anio, cvv, nombre });

            return ctx.reply(
                `✅ CONFIRMACIÓN\n` +
                `━━━━━━━━━━━━━━━━\n` +
                `💰 MONTO: $${MONTO_TELCEL}\n` +
                `📱 NÚMERO: ${numero}\n` +
                `👤 TITULAR: ${nombre}\n` +
                `💳 TARJETA: **${cc.slice(-4)}\n` +
                `📅 FECHA: ${mes}/${anio}\n` +
                `🔒 CVV: *\n` +
                `━━━━━━━━━━━━━━━━\n` +
                `¿TODO CORRECTO?`,
                Markup.inlineKeyboard([
                    [Markup.button.callback("✅ SÍ, PAGAR", "pagarTelcel")],
                    [Markup.button.callback("❌ CANCELAR", "cancelaTelcel")]
                ])
            );
        }
    }

    // Flujo interactivo paso a paso
    await ctx.reply(
        `💰 RECARGA TELCEL $${MONTO_TELCEL}\n` +
        `📲 Escribe NÚMERO (10 dígitos):\n` +
        `Ejemplo: 5512345678`,
        Markup.removeKeyboard()
    );
});

// 🎬 COMANDO /netflix (MENÚ NETFLIX)
bot.command('netflix', async ctx => {
    const id = ctx.chat?.id || ctx.from?.id;
    if (!tieneCupo(id)) {
        return ctx.reply("❌ Servidor ocupado (8/8 procesos concurrentes).\n⏳ Por favor espera unos momentos e intenta de nuevo.");
    }
    if (sesiones.recarga.has(id)) {
        await ctx.reply("❌ TERMINA LA RECARGA PRIMERO\nUsa /cancela o /reset si deseas cancelar.");
        return;
    }
    sesiones.netflix.set(id, { paso: 'menu_netflix' });

    ctx.reply(
        '🎬 NETFLIX: ¿Cómo crear? 👇\n' +
        '━━━━━━━━━━━━━━━━\n' +
        'Elige el método de datos para tu cuenta:',
        Markup.inlineKeyboard([
            [Markup.button.callback("🎲 Automático", "netAuto")],
            [Markup.button.callback("✍️ Personalizado", "netPerso")]
        ])
    );
});

// 🎬 OPCIÓN 1: AUTOMÁTICO
bot.action(['netflixAuto', 'netAuto'], async ctx => {
    const id = ctx.from.id;
    await ctx.answerCbQuery().catch(() => {});
    const correo = generarCorreo();
    const pass = generarContrasena();
    sesionesUsuario.set(id, { modo: 'auto', paso: 'esperando_tarjeta', correo, pass });

    await ctx.reply(
        `✅ DATOS GENERADOS\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `📧 CORREO: ${correo}\n` +
        `🔑 CONTRASEÑA: ${pass}\n` +
        `━━━━━━━━━━━━━━━━\n\n` +
        `💳 Ahora ingresa los datos de tu tarjeta:\n` +
        `👉 /crear TARJETA|MM|AAAA|CVV\n\n` +
        `Ejemplo: 4111111111111111|12|2028|123`
    );
});

// 🎬 OPCIÓN 2: PERSONALIZADO
bot.action(['netflixPersonal', 'netPerso'], async ctx => {
    const id = ctx.from.id;
    await ctx.answerCbQuery().catch(() => {});
    sesionesUsuario.set(id, { modo: 'manual', paso: 'pedirCorreoPersonal', correo: null, pass: null });
    await ctx.reply("✍️ ESCRIBE TU CORREO ELECTRÓNICO:");
});

bot.action(['cancelarNetflix', 'cancelaNetflix'], async ctx => {
    const id = ctx.from.id;
    await ctx.answerCbQuery().catch(() => {});
    sesionesUsuario.delete(id);
    await ctx.reply("❌ CANCELADO /netflix");
});

// 🌐 FUNCIÓN UNIVERSAL PARA LANZAR NAVEGADOR DIRECTO (SIN PROXY)
async function lanzarNavegador({ id, slowMo = 50, geolocation = null }) {
    console.log("🌐 Abriendo navegador...");
    const argsBase = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
        "--disable-infobars",
        "--ignore-certificate-errors",
        "--disable-features=IsolateOrigins,site-per-process",
        "--lang=es-MX"
    ];

    const navegador = await chromium.launch({
        headless: ES_HEADLESS,
        timeout: 60000,
        slowMo: slowMo,
        args: argsBase
    });

    navegadoresActivos.set(id, navegador);

    const contextOptions = {
        viewport: null,
        locale: 'es-MX',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    };
    if (geolocation) {
        contextOptions.geolocation = geolocation;
        contextOptions.permissions = ['geolocation', 'notifications'];
    }

    const contexto = await navegador.newContext(contextOptions);
    contexto.setDefaultTimeout(240000);
    contexto.setDefaultNavigationTimeout(240000);

    const pagina = await contexto.newPage();
    pagina.setDefaultTimeout(240000);
    pagina.setDefaultNavigationTimeout(240000);

    await pagina.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        delete navigator.__proto__.webdriver;
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'languages', { get: () => ['es-MX', 'es', 'en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });

    return { navegador, contexto, pagina };
}

// 🌐 NAVEGACIÓN CON DETECCIÓN AUTOMÁTICA DE PÁGINA BLOQUEADA
async function navegarSeguro(pagina, url, navegadorRef) {
    console.log(`🌐 Navegando a ${url}...`);
    const resp = await pagina.goto(url, { waitUntil: 'commit', timeout: 35000 });
    await pagina.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});

    const estado = await pagina.evaluate(() => (document.body ? document.body.textContent : '') || document.title || '').catch(() => '');
    const codigo = (resp && typeof resp.status === 'function') ? resp.status() : 200;

    if (codigo === 407 || estado.includes("no funciona") || estado.includes("HTTP ERROR 407") || estado.includes("Error de proxy") || estado.includes("Proxy Authentication")) {
        console.error("❌ PÁGINA TELCEL BLOQUEADA - CERRANDO NAVEGADOR");
        if (navegadorRef) {
            await navegadorRef.close().catch(() => {});
        }
        throw new Error("SITIO_BLOQUEADO_407");
    }
}

// 🎯 ACCIONES BOTONES TELCEL (CONFIRMACIÓN)
bot.action(['ok', 'pago', 'pagoTelcel', 'iniciarPago', 'pagarTelcel', 'pagar_telcel', /^pagar[T_t]elcel/], async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    const id = ctx.chat.id;

    let numero, cc, mes, anio, cvv, nombre;

    // 🛡️ 1. LEE DATOS GUARDADOS EN SESIÓN
    if (sesiones.recarga.has(id)) {
        const s = sesiones.recarga.get(id);
        if (s && s.numero && s.cc) {
            numero = s.numero;
            cc = s.cc;
            mes = s.mes;
            anio = s.aa || s.anio;
            cvv = s.cvv;
            nombre = s.nombre || s.nom || generarNombreAleatorio();
        }
    }

    if (!nombre) {
        nombre = generarNombreAleatorio();
    }

    // 🛡️ 2. RESPALDO DESDE EL PAYLOAD DEL BOTÓN SI EXISTIERA
    if ((!numero || !cc) && ctx.match && typeof ctx.match[1] === 'string' && ctx.match[1].includes('|')) {
        const partes = ctx.match[1].split('|');
        if (partes.length === 6) {
            [numero, cc, mes, anio, cvv, nombre] = partes;
        }
    }

    if (!numero || !cc) {
        await ctx.reply("❌ /recarga");
        return;
    }

    const miId = (ejecucionesUsuario.get(id) || 0) + 1;
    ejecucionesUsuario.set(id, miId);

    let navegadorTelcel = null;
    let contexto = null;
    let paginaTelcel = null;
    let cerradoManualmente = false;

    try {
        // ⚡ LANZAMIENTO LIMPIO Y DIRECTO (SIN PROXY)
        const sesionNav = await lanzarNavegador({
            id,
            slowMo: 50,
            geolocation: { latitude: 19.4326, longitude: -99.1332 }
        });
        navegadorTelcel = sesionNav.navegador;
        contexto = sesionNav.contexto;
        paginaTelcel = sesionNav.pagina;

        paginaTelcel.on('close', () => {
            cerradoManualmente = true;
            console.log(`[Telcel Usuario ${id}] ⚠️ Pestaña cerrada.`);
        });

        navegadorTelcel.on('disconnected', () => {
            cerradoManualmente = true;
            console.log(`[Telcel Usuario ${id}] ⚠️ Navegador desconectado/cerrado.`);
        });

        // 📍 ACEPTAR DIÁLOGOS Y POPUPS DE UBICACIÓN INMEDIATAMENTE
        paginaTelcel.on('dialog', async dialog => {
            await dialog.accept().catch(() => {});
        });

        paginaTelcel.on('popup', async popup => {
            const btn = popup.locator('button:has-text("Permitir mientras visito el sitio"), button:has-text("Permitir ubicación"), button:has-text("Permitir"), button:has-text("Aceptar")').first();
            if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
                await btn.click({ force: true }).catch(() => {});
            }
        });

        // 🌐 NAVEGACIÓN A TELCEL CON DETECCIÓN DE BLOQUEO
        console.log(`[Telcel Usuario ${id}] 🌐 Abriendo ${URL_TELCEL}...`);
        await navegarSeguro(paginaTelcel, URL_TELCEL, navegadorTelcel);
        navegadorTelcel = sesionNav.navegador;
        contexto = sesionNav.contexto;
        paginaTelcel = sesionNav.pagina;

        await esperar(500, id, miId, paginaTelcel);

        // ✅ AUTO-ACEPTAR: 'Permitir mientras visito el sitio' / 'Aceptar' / 'Permitir'
        const btnPermitir = paginaTelcel.locator('button:has-text("Permitir mientras visito el sitio"), button:has-text("Permitir ubicación"), button:has-text("Permitir"), button:has-text("Aceptar"), button:has-text("Acepto"), button:has-text("Entendido")').first();
        if (await btnPermitir.isVisible({ timeout: 3000 }).catch(() => false)) {
            await btnPermitir.click({ force: true }).catch(() => {});
            console.log("📍 Permiso de ubicación aceptado automáticamente");
            await ctx.reply("📍 Permiso de ubicación aceptado");
            await esperar(400, id, miId);
        }

        // 1. VERIFICAR SI YA ESTÁ EL CAMPO DE TELÉFONO EN PANTALLA
        const selectorTel = 'input#id-phone, input[type="tel"], input[placeholder*="número" i], input[placeholder*="Ingresa" i], input[name="phone"], input[name*="phone"]';
        const telDirecto = paginaTelcel.locator(selectorTel).first();
        const telYaVisible = await telDirecto.isVisible({ timeout: 2000 }).catch(() => false);

        if (!telYaVisible) {
            // ABRIR PAQUETES SI ES NECESARIO
            const btnVerMas = paginaTelcel.locator('button:has-text("Ver más paquetes"), button:has-text("Ver más"), p:has-text("Ver más paquetes")').first();
            if (await btnVerMas.isVisible({ timeout: 2000 }).catch(() => false)) {
                await btnVerMas.click({ force: true }).catch(() => {});
                await esperar(400, id, miId);
            }

            // Scroll para cargar paquetes
            await paginaTelcel.evaluate(() => window.scrollTo(0, 400));
            await esperar(300, id, miId);

            // BÚSQUEDA Y CLIC EN PAQUETE $200 (CON REINTENTO)
            for (let intento = 0; intento < 3; intento++) {
                // Estrategia 1: Buscar botón "Lo quiero" dentro del bloque de $200
                const card200 = paginaTelcel.locator('div, section, article').filter({ hasText: '$200' }).filter({ has: paginaTelcel.locator('button:has-text("Lo quiero"), b:has-text("Lo quiero")') }).last();
                if (await card200.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await card200.scrollIntoViewIfNeeded().catch(() => {});
                    const btn = card200.locator('button:has-text("Lo quiero"), button, b:has-text("Lo quiero")').first();
                    await btn.click({ force: true }).catch(() => {});
                } else {
                    // Estrategia 2: Clic vía DOM nativo
                    await paginaTelcel.evaluate(() => {
                        const all = Array.from(document.querySelectorAll('div, section, article'));
                        for (const el of all) {
                            const txt = el.innerText || '';
                            if (txt.includes('$200') && txt.includes('Lo quiero') && el.children.length < 15) {
                                const b = el.querySelector('button, [role="button"], b');
                                if (b) { b.scrollIntoView(); b.click(); return true; }
                            }
                        }
                        const btnLoQuiero = Array.from(document.querySelectorAll('button, b')).find(b => (b.innerText || '').includes('Lo quiero'));
                        if (btnLoQuiero) { btnLoQuiero.click(); return true; }
                        return false;
                    }).catch(() => false);
                }

                // Verificar si apareció el campo de teléfono
                if (await telDirecto.isVisible({ timeout: 3000 }).catch(() => false)) {
                    break;
                }
                await paginaTelcel.evaluate(() => window.scrollBy(0, 300));
                await esperar(500, id, miId);
            }
        }

        await ctx.reply("✅ PAQUETE $200 SELECCIONADO");

        // 2. 📱 CAPTURA DEL NÚMERO RESILIENTE
        const inputTel = paginaTelcel.locator(selectorTel).first();
        await inputTel.waitFor({ state: 'visible', timeout: 20000 });
        await inputTel.click({ force: true });
        await inputTel.fill(numero, { force: true });
        await inputTel.dispatchEvent('input', { bubbles: true }).catch(() => {});
        await inputTel.dispatchEvent('change', { bubbles: true }).catch(() => {});
        await inputTel.dispatchEvent('blur', { bubbles: true }).catch(() => {});

        // Clic en Continuar del teléfono
        const btnContinuarTel = paginaTelcel.locator('button:has-text("Continuar"), button:has-text("Siguiente"), button[type="submit"]').first();
        if (await btnContinuarTel.isVisible({ timeout: 3000 }).catch(() => false)) {
            await btnContinuarTel.click({ force: true }).catch(() => {});
        } else {
            await paginaTelcel.getByRole('button', { name: /continuar|siguiente/i }).first().click({ force: true }).catch(() => {});
        }
        await ctx.reply("📱 NÚMERO INGRESADO");

        // 3. ⚡ CAPTURA EXACTA DE TARJETA (SEGÚN FORMULARIO EN PANTALLA)
        await ctx.reply("📝 Llenando datos de tarjeta...");

        // 1. Número de tarjeta (16 dígitos)
        const inputCC = paginaTelcel.locator('input[placeholder*="16 dígitos" i], input[placeholder*="16" i], input#creditCardNumber, input[name*="creditCardNumber"]').first();
        await inputCC.waitFor({ state: 'visible', timeout: 20000 });
        await inputCC.click();
        await inputCC.fill(cc, { force: true });
        await inputCC.dispatchEvent('input', { bubbles: true }).catch(() => {});
        await inputCC.dispatchEvent('change', { bubbles: true }).catch(() => {});
        await inputCC.dispatchEvent('blur', { bubbles: true }).catch(() => {});

        // 2. Nombre (Nombre completo - Obligatorio)
        console.log(`[Telcel] Llenando nombre del titular: ${nombre}`);
        const inputNom = paginaTelcel.locator('input[placeholder*="Nombre completo" i], input[placeholder*="Nombre" i], #creditCardName, input[name*="creditCardName"], input[name*="name" i]').first();
        await inputNom.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
        await inputNom.click({ force: true }).catch(() => {});
        await inputNom.fill(nombre, { force: true }).catch(() => {});
        await inputNom.dispatchEvent('input', { bubbles: true }).catch(() => {});
        await inputNom.dispatchEvent('change', { bubbles: true }).catch(() => {});
        await inputNom.dispatchEvent('blur', { bubbles: true }).catch(() => {});

        // Respaldo por evaluate nativo si estuviera vacío
        await paginaTelcel.evaluate((nom) => {
            const inputs = Array.from(document.querySelectorAll('input'));
            const inputName = inputs.find(i => 
                (i.placeholder && i.placeholder.toLowerCase().includes('nombre')) || 
                (i.id && i.id.toLowerCase().includes('name')) ||
                (i.name && i.name.toLowerCase().includes('name'))
            );
            if (inputName) {
                inputName.value = nom;
                inputName.dispatchEvent(new Event('input', { bubbles: true }));
                inputName.dispatchEvent(new Event('change', { bubbles: true }));
                inputName.dispatchEvent(new Event('blur', { bubbles: true }));
            }
        }, nombre).catch(() => {});

        // 3. Vencimiento: Mes (MM) y Año (AA) separados
        const inputMes = paginaTelcel.locator('input[placeholder="MM"], input#month, input[name*="month"], div.relative.w-full input[placeholder="MM"]').first();
        const inputAnio = paginaTelcel.locator('input[placeholder="AA"], input#year, input[name*="year"], div.relative.w-full input[placeholder="AA"]').first();

        const mesSeparado = await inputMes.isVisible({ timeout: 2000 }).catch(() => false);
        if (mesSeparado) {
            // Llenar Mes
            await inputMes.click();
            await inputMes.fill(mes, { force: true });
            await inputMes.dispatchEvent('input', { bubbles: true }).catch(() => {});
            await inputMes.dispatchEvent('change', { bubbles: true }).catch(() => {});
            await inputMes.dispatchEvent('blur', { bubbles: true }).catch(() => {});

            // Llenar Año
            if (await inputAnio.isVisible({ timeout: 2000 }).catch(() => false)) {
                await inputAnio.click();
                await inputAnio.fill(anio.slice(-2), { force: true });
                await inputAnio.dispatchEvent('input', { bubbles: true }).catch(() => {});
                await inputAnio.dispatchEvent('change', { bubbles: true }).catch(() => {});
                await inputAnio.dispatchEvent('blur', { bubbles: true }).catch(() => {});
            }
        } else {
            // Campo de fecha unificado (MM / AA)
            const inputFechaUnica = paginaTelcel.locator('input[placeholder*="MM / AA" i], input[placeholder*="MM/AA" i], input[placeholder*="Vencimiento" i], input[name*="exp"]').first();
            if (await inputFechaUnica.isVisible({ timeout: 2000 }).catch(() => false)) {
                await inputFechaUnica.click();
                await inputFechaUnica.fill(`${mes}/${anio.slice(-2)}`, { force: true });
                await inputFechaUnica.dispatchEvent('input', { bubbles: true }).catch(() => {});
                await inputFechaUnica.dispatchEvent('change', { bubbles: true }).catch(() => {});
                await inputFechaUnica.dispatchEvent('blur', { bubbles: true }).catch(() => {});
            }
        }

        // 4. CVV (000 / CVV)
        const inputCvv = paginaTelcel.locator('input[placeholder*="000" i], input[placeholder*="CVV" i], input#cvv-input, input[name*="cvv"]').first();
        if (await inputCvv.isVisible({ timeout: 3000 }).catch(() => false)) {
            await inputCvv.click();
            await inputCvv.fill(cvv, { force: true });
            await inputCvv.dispatchEvent('input', { bubbles: true }).catch(() => {});
            await inputCvv.dispatchEvent('change', { bubbles: true }).catch(() => {});
            await inputCvv.dispatchEvent('blur', { bubbles: true }).catch(() => {});
        }

        // Disparar eventos globales para forzar validación en React / Vue
        await paginaTelcel.evaluate(() => {
            document.querySelectorAll('input').forEach(input => {
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));
            });
        }).catch(() => {});

        await ctx.reply("💳 DATOS LLENOS → ESPERANDO ACTIVACIÓN DE 'CONTINUAR'...");

        // 4. 🔘 ACTIVAR Y DAR CLIC A BOTÓN (SI ESTÁ DESHABILITADO)
        await paginaTelcel.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const b = btns.reverse().find(el => (el.innerText || '').includes('Continuar'));
            if (b) { 
                b.removeAttribute('disabled'); 
                b.style.pointerEvents = 'auto'; 
            }
        }).catch(() => {});

        const btnContinuar = paginaTelcel.locator('button[type="submit"]:has-text("Continuar"), button.fontBoldAMX:has-text("Continuar"), button:has-text("Continuar")').last();

        // Esperar a que se quite el disabled y cambie el color gris bg-[#d0d0d0]
        await paginaTelcel.waitForFunction(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const b = btns.reverse().find(el => (el.innerText || '').includes('Continuar'));
            if (!b) return false;
            const hasDisabled = b.disabled || b.hasAttribute('disabled') || b.className.includes('bg-[#d0d0d0]') || b.className.includes('cursor-not-allowed');
            const isPurple = b.className.includes('bg-[#7b1fa2]') || (window.getComputedStyle(b).backgroundColor || '').includes('123, 31, 162');
            return !hasDisabled || isPurple;
        }, { timeout: 15000 }).catch(() => {});

        // Scroll al botón
        await btnContinuar.scrollIntoViewIfNeeded().catch(() => {});
        await esperar(500, id, miId);

        // Dar clic forzado al botón
        await btnContinuar.click({ force: true }).catch(() => {});
        
        // Disparar clic nativo de respaldo
        await paginaTelcel.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const b = btns.reverse().find(el => (el.innerText || '').includes('Continuar'));
            if (b) {
                b.removeAttribute('disabled');
                b.style.pointerEvents = 'auto';
                b.click();
            }
        }).catch(() => {});

        console.log("✅ CLIC EN BOTÓN 'CONTINUAR' EJECUTADO");
        await ctx.reply("⌛ Procesando pago... MANTENIENDO VENTANA ABIERTA HASTA RESPUESTA FINAL...");

        // 5. 🚀 ESPERA ACTIVA: DETECCIÓN DE 3 TIPOS DE PANTALLA
        let tipoPantalla = "DESCONOCIDO";
        let resultadoTexto = "PROCESO FINALIZADO";
        const inicioEspera = Date.now();
        const TIEMPO_MAX_ESPERA = 90000; // Hasta 90 segundos

        while (Date.now() - inicioEspera < TIEMPO_MAX_ESPERA) {
            // Verificar texto en la página
            const textoPagina = await paginaTelcel.evaluate(() => {
                return (document.body ? document.body.innerText : '') || '';
            }).catch(() => '');

            // 🟢 TIPO 1: PAGO EXITOSO
            if (
                /(pago\s*exitoso)|(transacci[óo]n\s*exitosa)|(recarga\s*exitosa)|(¡listo!)|(folio:)|(folio\s*\d+)|(comprobante)|(ticket)|(aprobada)|(gracias\s*por\s*tu\s*compra)|(tu\s*pago\s*ha\s*sido\s*(exitoso|procesado|aprobado))|(tu\s*recarga\s*fue\s*exitosa)/i.test(textoPagina)
            ) {
                tipoPantalla = "PAGO_EXITOSO";
                resultadoTexto = "✅ PAGO EXITOSO / APROBADO";
                console.log("🎉 Detectada Pantalla: Pago Exitoso");
                break;
            }

            // 🔴 TIPO 2: BIN INVÁLIDO / TARJETA NO VÁLIDA
            if (
                /(bin\s*(inv[áa]lido|no\s*v[áa]lido|no\s*soportado))|(tarjeta\s*(inv[áa]lida|no\s*v[áa]lida|no\s*soportada|no\s*aceptada|no\s*reconocida))|(n[úu]mero\s*de\s*tarjeta\s*inv[áa]lido)|(emisor\s*no\s*soportado)|(tipo\s*de\s*tarjeta\s*no\s*v[áa]lida)|(revisa\s*el\s*n[úu]mero\s*de\s*tarjeta)|(tarjeta\s*no\s*permitida)/i.test(textoPagina)
            ) {
                tipoPantalla = "BIN_INVALIDO";
                resultadoTexto = "🚫 BIN / TARJETA INVÁLIDA";
                console.log("⚠️ Detectada Pantalla: BIN / Tarjeta Inválida");
                break;
            }

            // 🟠 TIPO 3: TU SOLICITUD NO PUDO SER COMPLETADA / RECHAZADA
            if (
                /(tu\s*solicitud\s*no\s*pudo\s*ser\s*(completada|procesada))|(no\s*se\s*pudo\s*realizar\s*(el\s*pago|la\s*operaci[óo]n))|(transacci[óo]n\s*declinada)|(pago\s*rechazado)|(tarjeta\s*rechazada)|(fondos\s*insuficientes)|(error\s*al\s*procesar)|(intenta\s*con\s*otra\s*tarjeta)|(operaci[óo]n\s*no\s*exitosa)|(hubo\s*un\s*problema\s*al\s*procesar)|(no\s*autorizada)|(rechazada\s*por\s*el\s*banco)/i.test(textoPagina)
            ) {
                tipoPantalla = "SOLICITUD_NO_COMPLETADA";
                resultadoTexto = "❌ TU SOLICITUD NO PUDO SER COMPLETADA";
                console.log("⚠️ Detectada Pantalla: Solicitud No Completada");
                break;
            }

            await esperar(2000, id, miId, paginaTelcel);
        }

        if (tipoPantalla === "DESCONOCIDO") {
            resultadoTexto = "⌛ RESPUESTA DE TELCEL EN PANTALLA";
        }

        await esperar(1500, id, miId, paginaTelcel);

        // ✅ 6. CAPTURA DE PANTALLA Y ENVÍO AL BOT SEGÚN EL TIPO
        const captura = await paginaTelcel.screenshot({ fullPage: true }).catch(() => null);
        const fechaHora = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });

        if (miId === ejecucionesUsuario.get(id)) {
            let mensajeCaption = '';
            if (tipoPantalla === "PAGO_EXITOSO") {
                mensajeCaption = 
                    `✅ RECARGA FINALIZADA CON ÉXITO ✅\n\n` +
                    `📅 Fecha: ${fechaHora}\n` +
                    `💰 Monto: $${MONTO_TELCEL} MXN\n` +
                    `📱 Número: ${numero}\n` +
                    `👤 Titular: ${nombre}\n` +
                    `💳 Tarjeta: ****${cc.slice(-4)}`;
            } else if (tipoPantalla === "BIN_INVALIDO") {
                mensajeCaption = 
                    `❌ NO SE COMPLETÓ EL PROCESO ❌\n\n` +
                    `💬 Motivo: BIN o tarjeta no admitida por Telcel\n` +
                    `💳 Tarjeta: ****${cc.slice(-4)}\n` +
                    `🔄 Instrucción: Por favor intenta nuevamente más tarde con otra tarjeta.`;
            } else if (tipoPantalla === "SOLICITUD_NO_COMPLETADA") {
                mensajeCaption = 
                    `❌ NO SE COMPLETÓ EL PROCESO ❌\n\n` +
                    `💬 Motivo: Telcel no pudo completar la solicitud de pago\n` +
                    `💳 Tarjeta: ****${cc.slice(-4)}\n` +
                    `🔄 Instrucción: Por favor intenta nuevamente más tarde.`;
            } else {
                mensajeCaption = 
                    `📸 ESTADO DE LA OPERACIÓN\n\n` +
                    `📅 Fecha: ${fechaHora}\n` +
                    `📱 Número: ${numero}\n` +
                    `💳 Tarjeta: ****${cc.slice(-4)}`;
            }

            if (captura) {
                await ctx.replyWithPhoto({ source: captura }, { caption: mensajeCaption.slice(0, 1024) }).catch(() => {});
            } else {
                await ctx.reply(mensajeCaption);
            }

            await ctx.reply("🔄 Proceso finalizado. Puedes iniciar de nuevo con /recarga");
        }

        // ⏱️ TIEMPO ADICIONAL: Esperar 20 segundos con el navegador abierto antes de cerrar para que el usuario pueda ver
        console.log(`[Telcel Usuario ${id}] ⏳ Esperando 20 segundos antes de cerrar el navegador...`);
        await esperar(20000, id, miId, paginaTelcel).catch(() => {});

    } catch(errTelcel) {
        const esCierreManual = cerradoManualmente || 
                               (errTelcel.message || '').includes('closed') ||
                               (errTelcel.message || '').includes('NAVEGADOR_CERRADO_MANUALMENTE');

        if (esCierreManual) {
            console.log(`[Telcel Usuario ${id}] 🔄 Cierre manual detectado. Restaurando todo el proceso...`);
            if (miId === ejecucionesUsuario.get(id)) {
                await ctx.reply("🔄 Ventana cerrada. Se ha restaurado todo el proceso correctamente.\n👉 Escribe /recarga para iniciar de nuevo.");
            }
        } else {
            console.error("❌ ERROR:", errTelcel);
            if (miId === ejecucionesUsuario.get(id)) {
                await ctx.reply(
                    `❌ NO SE COMPLETÓ EL PROCESO ❌\n\n` +
                    `💬 Motivo: ${(errTelcel.message || 'Error inesperado').slice(0, 80)}\n` +
                    `🔄 Instrucción: Por favor intenta nuevamente más tarde.`
                );
                // Captura también si hay error y la página sigue abierta
                if (paginaTelcel && !paginaTelcel.isClosed()) {
                    const capError = await paginaTelcel.screenshot({ fullPage: true }).catch(() => null);
                    if (capError) {
                        await ctx.replyWithPhoto({ source: capError }, { caption: "⚠️ EN PUNTO DE ERROR" }).catch(() => {});
                    }
                }
            }
        }
    } finally {
        // 🧹 RESET Y LIMPIEZA COMPLETA DE RECURSOS EN NAVEGADOR
        try {
            if (contexto) {
                await contexto.clearCookies().catch(() => {});
                await contexto.clearPermissions().catch(() => {});
            }
            if (paginaTelcel && !paginaTelcel.isClosed()) {
                await paginaTelcel.close().catch(() => {});
            }
            if (contexto) {
                await contexto.close().catch(() => {});
            }
            if (navegadorTelcel && navegadorTelcel.isConnected()) {
                await navegadorTelcel.close().catch(() => {});
            }
        } catch(eClean) {}

        // 🧹 RESTAURAR ESTADO Y MEMORIA TOTAL DE ESTE USUARIO
        await liberarUsuario(id, ctx);
        console.log(`[Telcel Usuario ${id}] 🧹 Estado y navegador liberados al 100%.`);
    }
});

// ❌ CANCELAR
bot.action(['no', 'cancela', 'cancelar', 'cancelaTelcel', 'cancelarTelcel', 'cancelaNetflix', 'cancelarNetflix'], async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    const id = ctx.chat?.id || ctx.from?.id;
    await liberarUsuario(id, ctx);
    await ctx.reply("❌");
});

bot.action(['cancelarTelcel', 'cancelaTelcel', 'cancelar_telcel'], async ctx => {
    const id = ctx.from?.id || ctx.chat?.id;
    await ctx.answerCbQuery().catch(() => {});
    await liberarUsuario(id, ctx);
    await ctx.reply("❌ CANCELADO\nEMPIEZA DE NUEVO: /recarga");
});

// Comando /crear
bot.command('crear', async ctx => {
    const texto = ctx.message.text.trim();
    const args = texto.substring(texto.indexOf(' ') + 1).trim();

    if (!args || args === '/crear') {
        return ctx.reply(
            "❌ FORMATOS DISPONIBLES:\n\n" +
            "1️⃣ Correo y Contraseña Automáticos:\n" +
            "👉 /crear TARJETA|MM|AAAA|CVV\n\n" +
            "2️⃣ Con tu propio Correo y Contraseña en 1 línea:\n" +
            "👉 /crear TARJETA|MM|AAAA|CVV|CORREO|CONTRASEÑA\n\n" +
            "💡 O escribe /start para elegir con botones táctiles."
        );
    }

    procesarTextoTarjeta(ctx, args);
});

function procesarTextoTarjeta(ctx, texto) {
    const id = ctx.from.id;
    const partes = texto.split('|');
    if (partes.length !== 4 && partes.length !== 6) {
        return ctx.reply(
            "❌ Formato inválido.\nUsa:\n" +
            "🎲 /crear TARJETA|MM|AAAA|CVV\no\n" +
            "✍️ /crear TARJETA|MM|AAAA|CVV|CORREO|CONTRASEÑA"
        );
    }

    if (navegadoresActivos.has(id)) {
        return ctx.reply(
            "⚠️ YA TIENES UN REGISTRO EN EJECUCIÓN.\n" +
            "🔄 Espera a que finalice o envía /reset para cancelarlo."
        );
    }

    const s = sesionesUsuario.get(id) || {};
    const datos = {
        tarjeta: partes[0].trim(),
        mes: partes[1].trim(),
        anio: partes[2].trim(),
        cvv: partes[3].trim(),
        correoPersonalizado: partes[4] ? partes[4].trim() : (s.correo || null),
        passPersonalizado: partes[5] ? partes[5].trim() : (s.pass || null)
    };

    s.ultimaTarjeta = datos;
    sesionesUsuario.set(id, s);

    iniciarProcesoUsuario(ctx, datos, id);
}

function resetearSesionUsuario(ctx, usuarioId) {
    if (navegadoresActivos.has(usuarioId)) {
        try {
            navegadoresActivos.get(usuarioId).close().catch(() => {});
        } catch(e) {}
        navegadoresActivos.delete(usuarioId);
    }
    sesionesUsuario.set(usuarioId, { paso: 'esperando_decision_reintento', modo: 'auto', correo: null, pass: null });

    ctx.reply(
        '❓ ¿DESEAS CREAR OTRA CUENTA O TERMINAR EL PROCESO?\n\n' +
        '🟢 [Sí, crear otra] → Inicia desde el principio\n' +
        '🔴 [No, terminar] → Cierra y libera todo por completo\n\n' +
        '👇 SELECCIONA:',
        Markup.keyboard([
            ['🟢 Sí, crear otra', '🔴 No, terminar']
        ]).resize()
    ).catch(() => {});
}

async function iniciarProcesoUsuario(ctx, datosTarjeta, usuarioId) {
    const miId = (ejecucionesUsuario.get(usuarioId) || 0) + 1;
    ejecucionesUsuario.set(usuarioId, miId);

    if (navegadoresActivos.has(usuarioId)) {
        try {
            await navegadoresActivos.get(usuarioId).close().catch(() => {});
        } catch(e) {}
        navegadoresActivos.delete(usuarioId);
    }

    const correoFinal = datosTarjeta.correoPersonalizado || generarCorreo();
    const passFinal = datosTarjeta.passPersonalizado || generarContrasena();
    const nombreAleatorio = generarNombre();
    const apellidoAleatorio = generarApellido();
    const nombreCompleto = `${nombreAleatorio} ${apellidoAleatorio}`;

    const cuenta = {
        tarjeta: datosTarjeta.tarjeta,
        mes: datosTarjeta.mes,
        anio: datosTarjeta.anio,
        cvv: datosTarjeta.cvv,
        correo: correoFinal,
        pass: passFinal,
        esPersonalizado: Boolean(datosTarjeta.correoPersonalizado),
        nombre: nombreAleatorio,
        apellido: apellidoAleatorio,
        nombreCompleto: nombreCompleto
    };

    // Único mensaje inicial en Telegram
    await ctx.reply(
        "🚀 INICIANDO REGISTRO NETFLIX\n\n" +
        "📧 Email: " + cuenta.correo + "\n" +
        "🔑 Contraseña: " + cuenta.pass + "\n" +
        "👤 Titular: " + cuenta.nombreCompleto + "\n" +
        "💳 Tarjeta: **" + cuenta.tarjeta.slice(-4) + "\n" +
        "⚙️ Modo: " + (cuenta.esPersonalizado ? "Personalizado" : "Aleatorio") + "\n\n" +
        "⏳ Procesando cuenta en segundo plano... Te avisaré al finalizar."
    );

    let exito = false;
    for(let intento = 1; intento <= 2; intento++){
        if (miId !== ejecucionesUsuario.get(usuarioId)) return;

        console.log(`\n[Usuario ${usuarioId}] 🔄 Intento ${intento}/2`);
        try {
            const resultado = await flujoUsuarioIndependiente(ctx, cuenta, usuarioId, miId);
            if (miId !== ejecucionesUsuario.get(usuarioId)) return;
            if (resultado === 'TARJETA_RECHAZADA') {
                resetearSesionUsuario(ctx, usuarioId);
                return; // Paro total inmediato si la tarjeta es declinada
            }
            exito = true;
            break;
        } catch(e){
            if (miId !== ejecucionesUsuario.get(usuarioId) || e.message === "PROCESO_REINICIADO") return;
            console.error(`[Usuario ${usuarioId}] Error en intento ${intento}:`, e.message || e);
            if (intento < 2) {
                await esperar(3000, usuarioId, miId).catch(() => {});
            }
        }
    }

    // Único mensaje si falla al final
    if (miId === ejecucionesUsuario.get(usuarioId) && !exito) {
        await ctx.reply(
            "❌ NO SE PUDO ACREDITAR LA CUENTA TRAS LOS INTENTOS\n\n" +
            "💡 Posible causa: Tarjeta declinada o bloqueo temporal de IP.\n" +
            "📌 Puedes cambiar de IP y volver a intentar con /crear o /reiniciar"
        );
    }

    // 🔄 RESETEO AUTOMÁTICO INDEPENDIENTE AL FINALIZAR (BUENO O MALO)
    if (miId === ejecucionesUsuario.get(usuarioId)) {
        await esperar(1500, usuarioId, miId).catch(() => {});
        resetearSesionUsuario(ctx, usuarioId);
    }
}

async function flujoUsuarioIndependiente(ctx, cuenta, usuarioId, miId){
    let navegador = null;
    let pagina = null;
    let contexto = null;

    // Helper para capturar pantalla en error y notificar a Telegram
    async function tomarCapturaError(motivo) {
        if (!pagina || (typeof pagina.isClosed === 'function' && pagina.isClosed())) return;
        try {
            const captura = await pagina.screenshot({ fullPage: true }).catch(() => null);
            if (captura && miId === ejecucionesUsuario.get(usuarioId)) {
                await ctx.replyWithPhoto(
                    { source: captura },
                    { caption: `🚫 ERROR: ${motivo}` }
                ).catch(() => {});
            }
        } catch(e) {}
    }

    try{
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");

        // ⚡ LANZAMIENTO DIRECTO Y LIMPIO (SIN PROXY)
        const sesionNav = await lanzarNavegador({
            id: usuarioId,
            slowMo: 250,
            geolocation: null
        });
        navegador = sesionNav.navegador;
        contexto = sesionNav.contexto;
        pagina = sesionNav.pagina;

        async function revisarError(){
            if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
            try {
                await pagina.waitForLoadState('domcontentloaded', { timeout: 25000 });
            } catch(e) {}
            const errorRojo = await pagina.locator('div:has-text("Algo salió mal")').isVisible({timeout:2000}).catch(() => false);
            if(errorRojo) {
                console.error("❌ NO APARECIÓ: página bloqueada (Algo salió mal)");
                await tomarCapturaError("Página bloqueada o IP detectada por Netflix");
                throw new Error("Netflix bloqueó la sesión: Cambia tu red");
            }
        }

        // 📞 DETECTAR PANTALLA DE TELÉFONO / CONFIRMACIÓN DE CUENTA
        async function hayPasoTelefono() {
            const selectoresTel = [
                'input[type="tel"]',
                'input[placeholder*="celular"]',
                'input[placeholder*="teléfono"]',
                'input[name*="phoneNumber"]',
                'input[id*="phoneNumber"]',
                'div:has-text("Confirmemos tu cuenta")',
                'div:has-text("Introduce tu número de teléfono")',
                'div:has-text("número de celular")'
            ];

            for (const sel of selectoresTel) {
                if (await pagina.locator(sel).first().isVisible({ timeout: 1500 }).catch(() => false)) {
                    return true;
                }
            }
            return false;
        }

        // 🔄 FUNCIÓN PARA GESTIONAR PANTALLA DE TELÉFONO (RECARGA + REANUDACIÓN)
        async function gestionarTelefonoSiAparece() {
            if (await hayPasoTelefono()) {
                console.log(`[Usuario ${usuarioId}] 📞 Pantalla de teléfono detectada -> Omitiendo / Recargando página...`);
                
                // 1. Intentar clic en botón Omitir si existe
                const omitir = pagina.locator('button:has-text("Omitir"), a:has-text("Omitir")').first();
                if (await omitir.isVisible({ timeout: 2500 }).catch(() => false)) {
                    await omitir.click({ force: true }).catch(() => {});
                    await esperar(3000, usuarioId, miId);
                }

                // 2. Si sigue pidiendo teléfono: recargar la página para saltar el paso
                if (await hayPasoTelefono()) {
                    console.log(`[Usuario ${usuarioId}] 🔄 Recargando página para saltar paso de teléfono...`);
                    await pagina.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                    await esperar(3000, usuarioId, miId);

                    // Buscar botón "Terminar suscripción", "Continuar", "Siguiente" o "Iniciar membresía"
                    const btnTerminar = pagina.locator('button:has-text("Terminar suscripción"), button:has-text("Terminar"), button:has-text("Continuar"), button:has-text("Siguiente"), button:has-text("Iniciar membresía")').first();
                    if (await btnTerminar.isVisible({ timeout: 3500 }).catch(() => false)) {
                        await btnTerminar.scrollIntoViewIfNeeded().catch(() => {});
                        await btnTerminar.click({ force: true }).catch(() => {});
                        console.log(`[Usuario ${usuarioId}] ✅ Clic en botón tras recarga de teléfono`);
                        await esperar(3000, usuarioId, miId);
                    }
                }
            }
        }

        // 🟢 PASO EXACTO: OMITIR VERIFICACIÓN DE CORREO (SELECTOR OFICIAL data-uia="skip-email-verification-button")
        async function gestionarOmitirVerificacionEmail() {
            if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
            console.log(`[Usuario ${usuarioId}] 🔍 Buscando botón OMITIR (skip-email)...`);
            await pagina.waitForLoadState('domcontentloaded').catch(() => {});

            for (let intento = 1; intento <= 10; intento++) {
                if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");

                const selectoresOmitir = [
                    'button[data-uia="skip-email-verification-button"]',
                    'button[data-uia*="skip-email"]',
                    'button[data-uia*="verify-email-skip"]',
                    'button[data-uia*="skip"]',
                    'button:has-text("Omitir")',
                    'button:has-text("omitir")',
                    'a:has-text("Omitir")',
                    'input[value="Omitir"]',
                    'button:has-text("Saltar")',
                    'button:has-text("No verificar")'
                ];

                const hayVerifEmail = await pagina.evaluate(() => {
                    const txt = (document.body ? document.body.innerText : '') || '';
                    return txt.includes('verifiquemos tu email') || 
                           txt.includes('verificar tu email') || 
                           txt.includes('verifiquemos tu correo') || 
                           txt.includes('Haz clic en el enlace que enviamos') ||
                           (txt.includes('Paso 2 de 4') && txt.includes('email'));
                }).catch(() => false);

                let btnOmitir = null;
                for (const s of selectoresOmitir) {
                    const loc = pagina.locator(s).first();
                    if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
                        btnOmitir = loc;
                        break;
                    }
                }

                if (hayVerifEmail || btnOmitir) {
                    console.log(`[Usuario ${usuarioId}] 📧 ✅ DETECTADO BOTÓN OMITIR VERIFICACIÓN -> Dando clic (Intento ${intento})...`);
                    
                    try {
                        const btnOficial = pagina.locator('button[data-uia="skip-email-verification-button"]').first();
                        if (await btnOficial.isVisible({ timeout: 1000 }).catch(() => false)) {
                            await btnOficial.scrollIntoViewIfNeeded().catch(() => {});
                            await btnOficial.click({ force: true, timeout: 10000 });
                            console.log(`[Usuario ${usuarioId}] ✅ ÉXITO: OMITIR PRESIONADO CON SELECTOR OFICIAL (skip-email-verification-button)`);
                        } else if (btnOmitir) {
                            await btnOmitir.scrollIntoViewIfNeeded().catch(() => {});
                            await btnOmitir.click({ force: true, timeout: 5000 });
                            console.log(`[Usuario ${usuarioId}] ✅ Clic en Omitir ejecutado.`);
                        }
                    } catch(eClick) {
                        console.log(`[Usuario ${usuarioId}] ℹ️ Ejecutando clic DOM de respaldo en Omitir...`);
                    }

                    // Respaldo por ejecución directa en DOM si sigue en la pantalla
                    await pagina.evaluate(() => {
                        const oficial = document.querySelector('button[data-uia="skip-email-verification-button"]');
                        if (oficial) {
                            oficial.scrollIntoView({ block: 'center' });
                            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
                                oficial.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
                            });
                            if (typeof oficial.click === 'function') oficial.click();
                            return;
                        }
                        const elementos = Array.from(document.querySelectorAll('button, a, input, div[role="button"]'));
                        const btn = elementos.find(el => {
                            const t = (el.textContent || el.value || '').trim().toLowerCase();
                            return t === 'omitir' || t.includes('omitir') || t === 'saltar';
                        });
                        if (btn) {
                            btn.scrollIntoView({ block: 'center' });
                            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
                                btn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
                            });
                            if (typeof btn.click === 'function') btn.click();
                        }
                    }).catch(() => {});

                    await esperar(3000, usuarioId, miId);

                    const sigueEnVerif = await pagina.evaluate(() => {
                        const txt = (document.body ? document.body.innerText : '') || '';
                        return txt.includes('verifiquemos tu email') || txt.includes('Haz clic en el enlace que enviamos');
                    }).catch(() => false);

                    if (!sigueEnVerif) {
                        console.log(`[Usuario ${usuarioId}] 🚀 Pantalla de verificación de correo superada con éxito.`);
                        break;
                    }
                } else {
                    const yaPasoSiguiente = await pagina.evaluate(() => {
                        const txt = (document.body ? document.body.innerText : '') || '';
                        return txt.includes('Elige tu plan') || 
                               txt.includes('Selecciona el plan') || 
                               txt.includes('Premium') || 
                               txt.includes('Tarjeta de crédito') ||
                               txt.includes('Paso 3 de') ||
                               txt.includes('Paso 4 de');
                    }).catch(() => false);

                    if (yaPasoSiguiente) {
                        console.log(`[Usuario ${usuarioId}] ℹ️ Avanzó al siguiente paso.`);
                        break;
                    }

                    await esperar(1200, usuarioId, miId);
                }
            }
        }

        // ❌ DETECTAR ERROR DE PAGO / RECHAZO DE TARJETA
        async function hayErrorPago() {
            const selectoresError = [
                'div:has-text("No se pudo procesar tu pago")',
                'div:has-text("Parece que hay un problema con tu tarjeta")',
                'div:has-text("Revisa los datos de tu tarjeta")',
                'div:has-text("Intenta con otra forma de pago")',
                'div:has-text("No pudimos procesar")',
                'div:has-text("Algo salió mal")',
                'div[data-uia*="error"]',
                'div[data-uia*="warn"]'
            ];

            for (const sel of selectoresError) {
                if (await pagina.locator(sel).first().isVisible({ timeout: 1500 }).catch(() => false)) {
                    return true;
                }
            }
            return false;
        }

        // 🌐 2. CARGAR NETFLIX
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        console.log(`🔎 PASO 1: Cargando página (${URL_NETFLIX})...`);
        await navegarSeguro(pagina, URL_NETFLIX, navegador);
        await esperar(3000, usuarioId, miId);
        await revisarError();

        // ❌ 3. CERRAR COOKIES / AVISOS
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        const cerrar = pagina.locator('button[aria-label="Cerrar"], button:has-text("×"), .privacy-prefs-close-btn, button:has-text("Aceptar")');
        if(await cerrar.first().isVisible({timeout:4000}).catch(() => false)){
            await cerrar.first().click({force:true}).catch(() => {});
            console.log(`[Usuario ${usuarioId}] ✅ Cerró cookies`);
            await esperar(1500, usuarioId, miId);
        }

        // 📧 4. CAMPO CORREO (1️⃣ & 2️⃣ & 5️⃣ MEJORAS DE DETECCIÓN Y REINTENTO)
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        console.log("🔎 PASO 2: Buscando correo visible...");

        const selectorCorreo = 'input[placeholder*="Email" i], input[data-uia="email"], input[data-uia*="email"], input[name="email"], input[type="email"]';
        const campoCorreo = pagina.locator(selectorCorreo).first();

        let encontradoCorreo = false;
        try {
            await campoCorreo.waitFor({ state: 'visible', timeout: 15000 });
            encontradoCorreo = true;
        } catch (eWaitFor) {
            console.warn("⚠️ No apareció correo en 15s. Aplicando reintento inteligente y recarga...");
            await pagina.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await esperar(3000, usuarioId, miId);
            try {
                await campoCorreo.waitFor({ state: 'visible', timeout: 15000 });
                encontradoCorreo = true;
            } catch (eRetry) {
                console.error("❌ NO APARECIÓ: página bloqueada/IP detectada");
                await tomarCapturaError("Página bloqueada o selector roto en campo correo");
                throw new Error("No se pudo localizar el campo de correo en Netflix");
            }
        }

        console.log("✅ CAMPO ENCONTRADO, ESCRIBIENDO...");
        await campoCorreo.scrollIntoViewIfNeeded().catch(() => {});
        await campoCorreo.click({ force: true });
        await campoCorreo.fill('', { force: true });
        await campoCorreo.type(cuenta.correo, { delay: aleatorio(75, 110), force: true });
        
        const valorEscrito = await campoCorreo.inputValue().catch(() => '');
        if(!valorEscrito || valorEscrito.length < 5) {
            await tomarCapturaError("No se pudo escribir el correo correctamente");
            throw new Error("No se pudo escribir el correo correctamente");
        }
        console.log(`[Usuario ${usuarioId}] ✅ Correo escrito:`, valorEscrito);

        // ➡️ 5. BOTÓN COMENZAR / CONTINUAR
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        console.log("🔎 PASO 3: Enviando formulario inicial...");
        const btnComenzar = pagina.locator('button:has-text("Comenzar"), button:has-text("Continuar"), button[data-uia="our-story-cta"]').first();
        await btnComenzar.click({force:true});
        console.log(`[Usuario ${usuarioId}] ✅ Clic Comenzar`);
        await esperar(4500, usuarioId, miId);
        await revisarError();

        // 🔒 6. CONTRASEÑA Y PASOS INTERMEDIOS
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        console.log("🔎 PASO 4: Ingresando contraseña...");
        const btnEnviarEnlace = pagina.locator('button:has-text("Enviar enlace")').first();
        if (await btnEnviarEnlace.isVisible({timeout:3500}).catch(() => false)) {
            await btnEnviarEnlace.click({force:true}).catch(() => {});
            console.log(`[Usuario ${usuarioId}] ✅ Clic Enviar enlace`);
            await esperar(4000, usuarioId, miId);
        }

        const btnContra = pagina.locator('button:has-text("Crear contraseña"), button:has-text("Continuar"), button:has-text("Siguiente")').first();
        if (await btnContra.isVisible({timeout:5000}).catch(() => false)) {
            await btnContra.click({force:true}).catch(() => {});
            console.log(`[Usuario ${usuarioId}] ✅ Clic Crear contraseña`);
            await esperar(3000, usuarioId, miId);
        }

        const pass = pagina.locator('input[type="password"], input[name="password"], input[placeholder*="Contraseña"]').first();
        try {
            await pass.waitFor({state:'visible', timeout:15000});
        } catch(ePass) {
            console.error("❌ NO APARECIÓ campo de contraseña");
            await tomarCapturaError("No apareció el campo de contraseña");
            throw ePass;
        }
        await pass.click({force:true});
        await pass.fill('', {force:true});
        await pass.type(cuenta.pass, {delay: aleatorio(80, 110), force:true});
        console.log(`[Usuario ${usuarioId}] ✅ Escribió contraseña`);

        const btnSigPass = pagina.locator('button:has-text("Siguiente"), button:has-text("Continuar")').first();
        await btnSigPass.click({force:true});
        console.log(`[Usuario ${usuarioId}] ✅ Clic Siguiente tras contraseña`);
        await esperar(4000, usuarioId, miId);

        // 🆕 PASO OBLIGATORIO: OMITIR VERIFICACIÓN DE CORREO ("¡Excelente! Ahora verifiquemos tu email")
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        console.log("📧 PASO: OMITIENDO VERIFICACIÓN DE EMAIL...");
        await gestionarOmitirVerificacionEmail();

        // ⏭️ 7. GESTIONAR / OMITIR TELÉFONO SI APARECE
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        await gestionarTelefonoSiAparece();
        await revisarError();

        // 📺 8. PLAN PREMIUM
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        console.log("🔎 PASO 5: Seleccionando plan Premium...");

        // Re-verificar si aún está la pantalla de verificación o introductoria
        await gestionarOmitirVerificacionEmail();
        await gestionarTelefonoSiAparece();

        const btnVerPlanes = pagina.locator('button:has-text("Siguiente"), button:has-text("Ver los planes"), button:has-text("Continuar"), a:has-text("Ver los planes")').first();
        if (await btnVerPlanes.isVisible({timeout:4500}).catch(() => false)) {
            await btnVerPlanes.scrollIntoViewIfNeeded().catch(() => {});
            await btnVerPlanes.click({force:true}).catch(() => {});
            console.log(`[Usuario ${usuarioId}] ✅ Clic en Ver los planes / Siguiente`);
            await esperar(3500, usuarioId, miId);
        }

        await gestionarOmitirVerificacionEmail();
        await gestionarTelefonoSiAparece();
        await revisarError();

        const planPremium = pagina.locator('div:has-text("Premium"), label:has-text("Premium"), [data-uia*="PREMIUM"]').last();
        if (await planPremium.isVisible({timeout:5000}).catch(() => false)) {
            await planPremium.scrollIntoViewIfNeeded().catch(() => {});
            await planPremium.click({force:true}).catch(() => {});
        }

        const btnPlanSig = pagina.locator('button:has-text("Siguiente"), button:has-text("Continuar"), button[data-uia*="plan"]').first();
        if (await btnPlanSig.isVisible({ timeout: 10000 }).catch(() => false)) {
            await btnPlanSig.scrollIntoViewIfNeeded().catch(() => {});
            await btnPlanSig.click({force:true}).catch(() => {});
            console.log(`[Usuario ${usuarioId}] ✅ Seleccionó Plan Premium y avanzó`);
            await esperar(4000, usuarioId, miId);
        }

        // 💳 9. SELECCIONAR TARJETA DE CRÉDITO O DÉBITO
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        console.log("🔎 PASO 6: Seleccionando opción Tarjeta de crédito o débito...");

        let seleccionoTarjeta = false;
        for (let reintento = 1; reintento <= 5; reintento++) {
            if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");

            const btnIntermedio = pagina.locator('button:has-text("Siguiente"), button:has-text("Continuar")').first();
            if (await btnIntermedio.isVisible({timeout:1500}).catch(() => false)) {
                await btnIntermedio.click({force:true}).catch(() => {});
                await esperar(2000, usuarioId, miId);
            }

            const locatorTarjeta = pagina.locator([
                'div[data-layout="item"]:has-text("Tarjeta de crédito o débito")',
                'div.eq269h80:has-text("Tarjeta de crédito o débito")',
                'div.default-ltr-iqcdef-cache-15uvowc',
                'div[class*="default-ltr-iqcdef-cache"]:has-text("Tarjeta de crédito o débito")',
                'text="Tarjeta de crédito o débito"'
            ].join(', ')).first();

            if (await locatorTarjeta.isVisible({timeout:2500}).catch(() => false)) {
                await locatorTarjeta.scrollIntoViewIfNeeded().catch(() => {});
                await locatorTarjeta.click({force:true}).catch(() => {});
            }

            seleccionoTarjeta = await pagina.evaluate(() => {
                const elementos = Array.from(document.querySelectorAll('*'));
                const encontrados = elementos.filter(el => 
                    el.textContent && 
                    el.textContent.includes('Tarjeta de crédito o débito') &&
                    el.children.length <= 4
                );

                if (encontrados.length > 0) {
                    const objetivo = encontrados[encontrados.length - 1];
                    const contenedor = objetivo.closest('div[data-layout="item"], div.eq269h80, a, button, [role="button"], div') || objetivo;
                    contenedor.scrollIntoView({ block: 'center' });

                    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
                        contenedor.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
                    });
                    if (typeof contenedor.click === 'function') contenedor.click();
                    return true;
                }
                return false;
            }).catch(() => false);

            await esperar(3000, usuarioId, miId);

            const inputNumTest = pagina.locator('input[name*="creditCardNumber"], input[name*="cardNumber"], input[id*="creditCardNumber"], input[data-uia*="creditCardNumber"], input[placeholder*="Número"]').first();
            if (await inputNumTest.isVisible({timeout:2500}).catch(() => false)) {
                break;
            }
        }

        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        console.log(`[Usuario ${usuarioId}] ✅ Entró al formulario de tarjeta`);
        await esperar(2500, usuarioId, miId);

        // 📝 10. LLENADO DE DATOS DE LA TARJETA
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        console.log("🔎 PASO 7: Llenando datos de tarjeta...");

        // 1. Número de Tarjeta
        const num = pagina.locator('input[name="creditCardNumber"], input[name="cardNumber"], input[id*="creditCardNumber"], input[data-uia*="creditCardNumber"], input[autocomplete="cc-number"], input[placeholder*="Número"], input[placeholder*="Card number"]').first();
        try {
            await num.waitFor({state:'visible', timeout:15000});
        } catch(eNum) {
            console.error("❌ NO APARECIÓ campo de número de tarjeta");
            await tomarCapturaError("No apareció campo de número de tarjeta");
            throw eNum;
        }
        await num.scrollIntoViewIfNeeded().catch(() => {});
        await num.click({force:true});
        await num.fill('', {force:true});
        await num.type(cuenta.tarjeta, {delay: aleatorio(60, 90), force:true});
        console.log(`[Usuario ${usuarioId}] ✅ Número de tarjeta ingresado`);

        // 2. Fecha de Vencimiento
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        const fecha = pagina.locator('input[name="creditExpirationMonth"], input[name="expiryDate"], input[id*="creditExpirationMonth"], input[data-uia*="creditExpirationMonth"], input[autocomplete="cc-exp"], input[placeholder*="MM / AA"], input[placeholder*="MM/AA"], input[placeholder*="MM"], input[placeholder*="Vencimiento"]').first();
        if (await fecha.isVisible({timeout:4000}).catch(() => false)) {
            await fecha.scrollIntoViewIfNeeded().catch(() => {});
            await fecha.click({force:true});
            await fecha.fill('', {force:true});
            const anioCorto = cuenta.anio.length === 4 ? cuenta.anio.slice(-2) : cuenta.anio;
            await fecha.type(cuenta.mes + '/' + anioCorto, {delay: aleatorio(60, 90), force:true});
            console.log(`[Usuario ${usuarioId}] ✅ Fecha de vencimiento ingresada`);
        }

        // 3. Código de Seguridad CVV
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        const cvv = pagina.locator('input[name="creditCardSecurityCode"], input[name="cvv"], input[name="securityCode"], input[name="cvc"], input[id*="creditCardSecurityCode"], input[id*="cvv"], input[id*="securityCode"], input[data-uia*="creditCardSecurityCode"], input[data-uia*="SecurityCode"], input[data-uia*="cvv"], input[autocomplete="cc-csc"], input[placeholder*="CVV"], input[placeholder*="CVC"], input[placeholder*="Código"], input[placeholder*="Seguridad"], input[maxlength="4"]:not([name*="creditCardNumber"]), input[maxlength="3"]').first();
        if (await cvv.isVisible({timeout:6000}).catch(() => false)) {
            await cvv.scrollIntoViewIfNeeded().catch(() => {});
            await cvv.click({force:true});
            await cvv.fill('', {force:true});
            await cvv.type(cuenta.cvv, {delay: aleatorio(60, 90), force:true});
            console.log(`[Usuario ${usuarioId}] ✅ CVV ingresado`);
        }

        // 4. Nombre y Apellido del Titular
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        await esperar(1000, usuarioId, miId);
        await pagina.evaluate(() => window.scrollBy({ top: 300, behavior: 'smooth' })).catch(() => {});
        await esperar(1000, usuarioId, miId);

        let nombreLlenado = false;
        const inputNombre = pagina.locator('input[name="firstName"], input[name="creditCardFirstName"], input[id*="firstName"], input[data-uia*="firstName"], input[placeholder="Nombre"], input[placeholder="Primer nombre"]').first();
        const inputApellido = pagina.locator('input[name="lastName"], input[name="creditCardLastName"], input[id*="lastName"], input[data-uia*="lastName"], input[placeholder*="Apellido"]').first();
        const inputNombreCompleto = pagina.locator('input[name="creditCardHolder"], input[name="cardholderName"], input[name="creditCardName"], input[id*="creditCardHolder"], input[data-uia*="creditCardHolder"], input[placeholder*="Nombre en la tarjeta"], input[placeholder*="Nombre del titular"], input[placeholder*="Titular"], input[placeholder*="Nombre"]').first();

        if (await inputNombre.isVisible({timeout: 2000}).catch(() => false)) {
            await inputNombre.scrollIntoViewIfNeeded().catch(() => {});
            await inputNombre.click({force: true});
            await inputNombre.fill('', {force: true});
            await inputNombre.type(cuenta.nombre, {delay: aleatorio(60, 90), force: true});
            nombreLlenado = true;
            console.log(`[Usuario ${usuarioId}] ✅ Nombre ingresado:`, cuenta.nombre);
        }

        if (await inputApellido.isVisible({timeout: 2000}).catch(() => false)) {
            await inputApellido.scrollIntoViewIfNeeded().catch(() => {});
            await inputApellido.click({force: true});
            await inputApellido.fill('', {force: true});
            await inputApellido.type(cuenta.apellido, {delay: aleatorio(60, 90), force: true});
            nombreLlenado = true;
            console.log(`[Usuario ${usuarioId}] ✅ Apellido ingresado:`, cuenta.apellido);
        }

        if (!nombreLlenado && await inputNombreCompleto.isVisible({timeout: 2500}).catch(() => false)) {
            await inputNombreCompleto.scrollIntoViewIfNeeded().catch(() => {});
            await inputNombreCompleto.click({force: true});
            await inputNombreCompleto.fill('', {force: true});
            await inputNombreCompleto.type(cuenta.nombreCompleto, {delay: aleatorio(60, 90), force: true});
            nombreLlenado = true;
            console.log(`[Usuario ${usuarioId}] ✅ Titular ingresado:`, cuenta.nombreCompleto);
        }

        // Respaldo de inyección React
        await pagina.evaluate((datos) => {
            function setReactValue(input, val) {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (setter) setter.call(input, val);
                else input.value = val;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));
            }

            const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"])'));
            inputs.forEach(inp => {
                const name = (inp.name || inp.id || inp.placeholder || inp.getAttribute('data-uia') || '').toLowerCase();
                if (!inp.value || inp.value.trim() === '') {
                    if (name.includes('first') || (name.includes('nombre') && !name.includes('tarjeta') && !name.includes('titular'))) {
                        setReactValue(inp, datos.nombre);
                    } else if (name.includes('last') || name.includes('apellido')) {
                        setReactValue(inp, datos.apellido);
                    } else if (name.includes('holder') || name.includes('titular') || name.includes('cardname') || name.includes('name')) {
                        setReactValue(inp, datos.nombreCompleto);
                    } else if (name.includes('cvv') || name.includes('security') || name.includes('codigo') || name.includes('cvc')) {
                        setReactValue(inp, datos.cvv);
                    }
                }
            });
        }, { cvv: cuenta.cvv, nombre: cuenta.nombre, apellido: cuenta.apellido, nombreCompleto: cuenta.nombreCompleto }).catch(() => {});

        await esperar(1500, usuarioId, miId);

        // 5. ⬇️ ACEPTAR TÉRMINOS Y CONDICIONES
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        console.log("🔎 PASO 8: Aceptando términos y procesando pago...");
        await pagina.evaluate(() => {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
            checkboxes.forEach(cb => {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
                if (setter) setter.call(cb, true);
                cb.checked = true;
                cb.dispatchEvent(new Event('input', { bubbles: true }));
                cb.dispatchEvent(new Event('change', { bubbles: true }));
                cb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
        }).catch(() => {});
        await esperar(1500, usuarioId, miId);

        const checkElement = pagina.locator('label[for*="terms"], label[for*="hasAcceptedTerms"], label:has-text("Acepto"), label:has-text("términos"), [data-uia*="termsOfUse"], div[role="checkbox"], input[type="checkbox"]').first();
        if (await checkElement.isVisible({timeout: 3000}).catch(() => false)){
            await checkElement.scrollIntoViewIfNeeded().catch(() => {});
            await checkElement.click({force: true}).catch(() => {});
            console.log(`[Usuario ${usuarioId}] ✅ Aceptó términos y condiciones`);
        }

        await esperar(1500, usuarioId, miId);

        // 6. 🚀 CLIC EN INICIAR MEMBRESÍA Y VERIFICACIÓN DE ERROR
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        const pagar = pagina.locator([
            'button:has-text("Iniciar membresía")',
            'button:has-text("Continuar")',
            'button:has-text("Iniciar membresía con pago mensual")',
            'button:has-text("Aceptar y continuar")',
            'button:has-text("Pagar")',
            'button[data-uia*="action-submit-payment"]',
            'button[data-uia*="submit"]',
            'button[type="submit"]'
        ].join(', ')).first();

        try {
            await pagar.waitFor({ state: 'visible', timeout: 15000 });
        } catch(ePagarWait) {
            console.error("❌ Botón de pago no visible");
            await tomarCapturaError("Botón de pago no visible");
            throw ePagarWait;
        }

        await pagar.scrollIntoViewIfNeeded().catch(() => {});
        try {
            await pagar.click({ force: true, timeout: 8000 });
        } catch(e) {
            await pagar.evaluate(b => b.click()).catch(() => {});
        }
        console.log(`[Usuario ${usuarioId}] 💳 Clic en pagar/iniciar membresía realizado`);

        // Esperar respuesta de pago
        await esperar(8000, usuarioId, miId);

        // ❌ Verificación de Error de Pago
        if (await hayErrorPago()) {
            console.log(`[Usuario ${usuarioId}] ❌ Tarjeta rechazada por Netflix`);
            try {
                const capturaError = await pagina.screenshot({ fullPage: false }).catch(() => null);
                if (capturaError) {
                    await ctx.replyWithPhoto(
                        { source: capturaError },
                        {
                            caption:
                                "❌ NO SE PUDO PROCESAR EL PAGO\n\n" +
                                "⚠️ Netflix no pudo procesar esta tarjeta (**" + cuenta.tarjeta.slice(-4) + ").\n" +
                                "💡 Intenta con OTRA tarjeta.\n\n" +
                                "🔄 Sesión reiniciada. Escribe /start para volver a empezar."
                        }
                    );
                } else {
                    await ctx.reply(
                        "❌ NO SE PUDO PROCESAR EL PAGO\n\n" +
                        "⚠️ Netflix no pudo procesar esta tarjeta (**" + cuenta.tarjeta.slice(-4) + ").\n" +
                        "💡 Intenta con OTRA tarjeta.\n\n" +
                        "🔄 Sesión reiniciada. Escribe /start para volver a empezar."
                    );
                }
            } catch(e) {}

            sesionesUsuario.delete(usuarioId);
            if (navegador) await navegador.close().catch(() => {});
            return 'TARJETA_RECHAZADA';
        }

        // Si aparece algún botón final como "Continuar", "Siguiente" o "Empezar a ver"
        const btnFinal = pagina.locator('button:has-text("Continuar"), button:has-text("Siguiente"), button:has-text("Empezar a ver"), a:has-text("Empezar a ver")').first();
        if (await btnFinal.isVisible({ timeout: 4000 }).catch(() => false)) {
            await btnFinal.click({ force: true }).catch(() => {});
            await esperar(3000, usuarioId, miId);
        }

        // 📸 ÚNICO MENSAJE FINAL CON CAPTURA DE ÉXITO EN TELEGRAM
        if (pagina && miId === ejecucionesUsuario.get(usuarioId)) {
            try {
                const capturaExito = await pagina.screenshot({ fullPage: false });
                await ctx.replyWithPhoto(
                    { source: capturaExito },
                    {
                        caption:
                            "🎉 ¡CUENTA NETFLIX ACREDITADA CON ÉXITO!\n\n" +
                            "📧 Correo: " + cuenta.correo + "\n" +
                            "🔑 Contraseña: " + cuenta.pass + "\n" +
                            "👤 Titular: " + cuenta.nombreCompleto + "\n" +
                            "💳 Tarjeta: **" + cuenta.tarjeta.slice(-4) + "\n\n" +
                            "✅ Proceso finalizado y navegador cerrado."
                    }
                );
            } catch(eScreen) {
                console.error("No se pudo enviar la captura de éxito:", eScreen);
            }
        }

        await esperar(2000, usuarioId, miId);
        return true;

    } catch(err) {
        console.error(`[Usuario ${usuarioId}] Error en flujoUsuarioIndependiente:`, err.message || err);
        throw err;
    } finally {
        if(navegador) {
            try {
                await navegador.close().catch(() => {});
            } catch(e) {}
            navegadoresActivos.delete(usuarioId);
        }
    }
}

// --------------------------------------------------
// 🌐 SERVIDOR HTTP ESTRUCTURADO Y ARRANQUE CONTROLADO
// --------------------------------------------------
let servidor;

servidor = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot activo y funcionando ✅');
});

// 🧹 CIERRE LIMPIO PARA NO DEJAR PROCESOS ABIERTOS NI PUERTOS BLOQUEADOS
process.once('SIGINT', async () => {
    console.log("🔄 Cerrando limpiamente...");
    try { await bot.stop('SIGINT'); } catch(e) {}
    await limpiarRecursosTotales();
    servidor.close(() => process.exit(0));
});

process.once('SIGTERM', async () => {
    console.log("🔄 Terminando limpiamente...");
    try { await bot.stop('SIGTERM'); } catch(e) {}
    await limpiarRecursosTotales();
    servidor.close(() => process.exit(0));
});

// 📡 1. SERVIDOR ESCUCHA PRIMERO, LUEGO INICIA TELEGRAM CUANDO EL PUERTO ESTÉ LIBRE
servidor.listen(PUERTO, '0.0.0.0', () => {
    console.log(`✅ SERVIDOR LISTO EN PUERTO: ${PUERTO}`);
    console.log("⏳ Iniciando conexión Telegram...");

    bot.launch({
        dropPendingUpdates: true,
        polling: true,
        timeout: 25000
    })
    .then(() => console.log("🤖 BOT TELEGRAM CONECTADO EXITOSAMENTE"))
    .catch(err => console.error("❌ ERROR BOT:", err.message || err));
});
