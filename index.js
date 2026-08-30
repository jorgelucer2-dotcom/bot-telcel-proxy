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
const URL_NETFLIX = process.env.URL_NETFLIX || 'https://www.netflix.com/mx/';
const MONTO_TELCEL = 200;
const TIEMPO_MAX_COMANDO = 240000; // 4 minutos límite por proceso para evitar cuelgues
const MAX_USUARIOS = 2; // 🎯 Límite de 2 procesos simultáneos para evitar saturación de memoria

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: Infinity });

// --------------------------------------------------
// 🛡️ PROTECCIÓN GLOBAL CONTRA CAÍDAS DE NODE.JS
// --------------------------------------------------
process.on('uncaughtException', err => {
    console.error('💥 Excepción no controlada (Bot sigue vivo):', (err.message || err).toString().slice(0, 140));
});

process.on('unhandledRejection', err => {
    console.error('💥 Promesa rechazada (Bot sigue vivo):', (err.message || err).toString().slice(0, 140));
});

// 🧼 CIERRE TOTAL Y LIBERACIÓN DE MEMORIA (100% LIMPIO)
async function cerrarSesion(sesion) {
    if (!sesion) return;
    try { await sesion.pagina?.close({ runBeforeUnload: false }).catch(() => {}); } catch(e){}
    try { await sesion.ctx?.close().catch(() => {}); } catch(e){}
    try { await sesion.nav?.close().catch(() => {}); } catch(e){}
    // 🧼 LIMPIEZA TOTAL PARA NO ACUMULAR MEMORIA
    delete sesion.pagina;
    delete sesion.ctx;
    delete sesion.nav;
    global.gc?.(); // Forzar recolección de basura si está disponible
}

async function limpiarRecursosTotales() {
    for (const [uid, nav] of navegadoresActivos.entries()) {
        try {
            await nav.close().catch(() => {});
        } catch(e) {}
    }
    navegadoresActivos.clear();
    global.gc?.();
}

// Mapas independientes por usuario (Multi-usuario real con aislamiento total)
const sesiones = { recarga: new Map(), netflix: new Map() };
const sesionesUsuario = sesiones.netflix; // Alias para compatibilidad con flujo Netflix
const navegadoresActivos = new Map();
const ejecucionesUsuario = new Map();
const ultimoMensaje = new Map(); // chat_id -> message_id

// 🧼 FUNCIÓN CENTRAL: ENVÍO LIMPIO (BORRA MENSAJES ANTERIORES)
async function enviarLimpio(ctx, texto, opciones = {}) {
    const id = ctx.chat?.id || ctx.from?.id;
    if (!id) return ctx.reply(texto, opciones);

    // 1. Borrar mensaje anterior del bot si existe
    if (ultimoMensaje.has(id)) {
        const msgPrevioId = ultimoMensaje.get(id);
        if (msgPrevioId) {
            await ctx.deleteMessage(msgPrevioId).catch(() => {});
        }
        ultimoMensaje.delete(id);
    }

    // 2. Borrar mensaje del usuario para evitar acumulación
    if (ctx.message?.message_id) {
        await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    }

    // 3. Enviar nuevo mensaje y registrar su ID
    const nuevoMsg = await ctx.reply(texto, opciones).catch(err => {
        console.error(`[enviarLimpio Usuario ${id}] Error:`, err.message || err);
        return null;
    });

    if (nuevoMsg && nuevoMsg.message_id) {
        ultimoMensaje.set(id, nuevoMsg.message_id);
    }
    return nuevoMsg;
}

// 🧼 ENVÍO LIMPIO DE FOTOS / CAPTURAS
async function enviarFotoLimpia(ctx, foto, opciones = {}) {
    const id = ctx.chat?.id || ctx.from?.id;
    if (!id) return ctx.replyWithPhoto(foto, opciones);

    if (ultimoMensaje.has(id)) {
        const msgPrevioId = ultimoMensaje.get(id);
        if (msgPrevioId) {
            await ctx.deleteMessage(msgPrevioId).catch(() => {});
        }
        ultimoMensaje.delete(id);
    }

    if (ctx.message?.message_id) {
        await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    }

    const nuevoMsg = await ctx.replyWithPhoto(foto, opciones).catch(err => {
        console.error(`[enviarFotoLimpia Usuario ${id}] Error:`, err.message || err);
        return null;
    });

    if (nuevoMsg && nuevoMsg.message_id) {
        ultimoMensaje.set(id, nuevoMsg.message_id);
    }
    return nuevoMsg;
}

// 🧼 LIMPIEZA TOTAL DE SESIÓN Y MENSAJES
async function limpiarSesion(ctx) {
    const id = ctx.chat?.id || ctx.from?.id;
    if (!id) return;

    if (ultimoMensaje.has(id)) {
        const msgPrevioId = ultimoMensaje.get(id);
        if (msgPrevioId) {
            await ctx.deleteMessage(msgPrevioId).catch(() => {});
        }
        ultimoMensaje.delete(id);
    }

    if (ctx.message?.message_id) {
        await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    }

    await liberarUsuario(id, ctx);
}

// 🧹 Verificar cupo concurrente (Máximo 2 simultáneos en plan gratuito)
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

    // 🧼 Forzar recolección de basura si está disponible
    global.gc?.();

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

// 📌 MENÚ PRINCIPAL MULTIUSUARIO (MINIMALISTA Y LIMPIO)
bot.start(async ctx => {
    await limpiarSesion(ctx);
    const id = ctx.from.id;
    sesionesUsuario.set(id, { paso: 'menu', modo: 'auto', correo: null, pass: null });

    await enviarLimpio(
        ctx,
        `🤖 **MENÚ PRINCIPAL**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Selecciona el servicio que deseas utilizar:\n\n` +
        `📱 **Recarga Telcel $200**\n` +
        `🎬 **Netflix Premium (México)**`,
        Markup.keyboard([
            ['📱 RECARGA TELCEL $200'],
            ['🎬 NETFLIX PREMIUM']
        ]).resize()
    );
});

// Botón 📱 RECARGA TELCEL $200
bot.hears(['📱 RECARGA TELCEL $200', '📱 Recarga Telcel $200', 'Recarga Telcel', 'recarga telcel', 'Recarga Telcel $200'], async ctx => {
    const id = ctx.chat?.id || ctx.from?.id;
    await liberarUsuario(id, ctx);
    sesiones.recarga.set(id, { paso: 1 });
    await enviarLimpio(
        ctx,
        `💰 **RECARGA TELCEL $${MONTO_TELCEL} MXN**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📲 **PASO 1:** Escribe tu número celular a 10 dígitos:\n` +
        `Ejemplo: \`5512345678\``,
        Markup.removeKeyboard()
    );
});

// Botón 🎬 NETFLIX PREMIUM
bot.hears(['🎬 NETFLIX PREMIUM', '🎬 Netflix Premium', 'Netflix Premium', 'netflix premium', 'netflix', '🎲 Automático', '✍️ Manual'], async ctx => {
    const id = ctx.chat?.id || ctx.from?.id;
    await liberarUsuario(id, ctx);
    sesiones.netflix.set(id, { paso: 'menu_netflix' });
    await enviarLimpio(
        ctx,
        `🎬 **NETFLIX PREMIUM MÉXICO**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Elige el método de datos para tu cuenta:`,
        Markup.inlineKeyboard([
            [Markup.button.callback("🎲 Modo Automático", "netAuto")],
            [Markup.button.callback("✍️ Modo Personalizado", "netPerso")]
        ])
    );
});

// Botón 🟢 Sí, crear otra
bot.hears(['🟢 Sí, crear otra', 'Sí, crear otra', 'Si', 'Sí', 'si', 'sí'], async ctx => {
    await limpiarSesion(ctx);
    const id = ctx.from.id;
    sesionesUsuario.set(id, { paso: 'menu', modo: 'auto', correo: null, pass: null });
    await enviarLimpio(
        ctx,
        `🤖 **MENÚ PRINCIPAL**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Selecciona el servicio que deseas utilizar:`,
        Markup.keyboard([
            ['📱 RECARGA TELCEL $200'],
            ['🎬 NETFLIX PREMIUM']
        ]).resize()
    );
});

// Botón 🔴 No, terminar
bot.hears(['🔴 No, terminar', 'No, terminar', 'No', 'no'], async ctx => {
    await limpiarSesion(ctx);
    await enviarLimpio(
        ctx,
        `👋 **PROCESO FINALIZADO**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `✅ Todos los recursos han sido liberados al 100%.\n` +
        `📌 Cuando gustes volver a usar el bot, escribe /start`,
        Markup.removeKeyboard()
    );
});

// Listener de mensajes de texto: TELCEL PRIMERO Y EXCLUSIVO
bot.on('text', async (ctx, next) => {
    const id = ctx.chat?.id || ctx.from?.id;
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
                await enviarLimpio(ctx, "❌ Número inválido (deben ser 10 dígitos).\n\n📲 Escribe tu número celular:");
                return;
            }
            // ✅ ACTUALIZA ESTADO: PASO 2 = TARJETA
            sesiones.recarga.set(id, { paso: 2, numero: txt });
            await enviarLimpio(
                ctx,
                `✅ **NÚMERO RECIBIDO:** \`${txt}\`\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `💳 **PASO 2:** Envía tus datos de tarjeta:\n` +
                `Formato: \`16DÍGITOS|MM|AAAA|CVV\`\n` +
                `Ejemplo: \`4111111111111111|08|2027|123\``
            );
            return;
        }

        // PASO 2: RECIBIR TARJETA
        if (estado.paso === 2 || estado.paso === 'tarjeta' || estado.paso === 'esperando_tarjeta_telcel') {
            const partes = txt.split('|').map(p => p.trim());
            if (partes.length !== 4) {
                await enviarLimpio(
                    ctx,
                    "❌ Formato de tarjeta inválido.\n\n" +
                    "📌 Usa el formato: `16DÍGITOS|MM|AAAA|CVV`\n" +
                    "Ejemplo: `4111111111111111|08|2027|123`\n\n" +
                    "👉 Intenta de nuevo:"
                );
                return;
            }
            const [cc, mes, anioCompleto, cvv] = partes;
            if (!cc || !mes || !anioCompleto || !cvv) {
                await enviarLimpio(
                    ctx,
                    "❌ Faltan datos en la tarjeta.\n\n" +
                    "📌 Formato: `16DÍGITOS|MM|AAAA|CVV`\n" +
                    "👉 Intenta de nuevo:"
                );
                return;
            }
            const anio = (anioCompleto || '').slice(-2);
            const numero = estado.numero;
            const nombre = generarNombreCompleto();

            sesiones.recarga.set(id, { numero, cc, mes, aa: anio, anio, cvv, nombre });

            await enviarLimpio(
                ctx,
                `📋 **CONFIRMACIÓN DE RECARGA**\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `💰 **Monto:** $${MONTO_TELCEL} MXN\n` +
                `📱 **Número:** \`${numero}\`\n` +
                `👤 **Titular:** ${nombre}\n` +
                `💳 **Tarjeta:** \`****${cc.slice(-4)}\`\n` +
                `📅 **Vence:** ${mes}/${anio}\n` +
                `🔒 **CVV:** ***\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `¿Deseas procesar la recarga ahora?`,
                Markup.inlineKeyboard([
                    [Markup.button.callback("✅ SÍ, PAGAR", "pagarTelcel")],
                    [Markup.button.callback("❌ CANCELAR", "cancelaTelcel")]
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
            await enviarLimpio(ctx, "🔑 **Ingresa la CONTRASEÑA para tu cuenta:**");
            return;
        } else if (estado.paso === 'pass' || estado.paso === 'pedirPassPersonal' || estado.paso === 'esperando_pass') {
            estado.pass = txt;
            estado.paso = 'tarjeta';
            sesiones.netflix.set(id, estado);
            const { correo, pass } = estado;
            await enviarLimpio(
                ctx,
                `✅ **DATOS NETFLIX GUARDADOS**\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `📧 **Correo:** \`${correo}\`\n` +
                `🔑 **Contraseña:** \`${pass}\`\n` +
                `━━━━━━━━━━━━━━━━━━\n\n` +
                `💳 **Ahora envía tus datos de tarjeta:**\n` +
                `👉 \`TARJETA|MM|AAAA|CVV\`\n` +
                `Ejemplo: \`4111111111111111|12|2028|123\``
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
    await limpiarSesion(ctx);
    await enviarLimpio(
        ctx,
        `🛑 **PROCESO CANCELADO Y LIBERADO**\n\n` +
        `✅ El navegador se cerró y tu sesión se reinició al 100%.\n` +
        `📌 Escribe /start para comenzar de nuevo.`,
        Markup.removeKeyboard()
    );
});

// 🔄 REINICIAR CON LA ÚLTIMA TARJETA DEL USUARIO
bot.command(['reiniciar', 'reintentar'], async ctx => {
    const id = ctx.from?.id || ctx.chat?.id;
    const s = sesionesUsuario.get(id);

    if (!s || !s.ultimaTarjeta) {
        return enviarLimpio(ctx, "⚠️ No tienes datos de tarjeta previos para reiniciar.\n📌 Envía: /crear TARJETA|MM|AAAA|CVV");
    }

    await enviarLimpio(ctx, "🔄 **REINICIANDO TU REGISTRO DESDE CERO...**");
    await iniciarProcesoUsuario(ctx, s.ultimaTarjeta, id);
});

// ==================================================
// 📱 RECARGA: INICIO Y LIMPIEZA
// ==================================================
bot.command(['recarga', 'telcel'], async ctx => {
    const id = ctx.chat?.id || ctx.from?.id;
    if (!tieneCupo(id)) {
        return enviarLimpio(ctx, "❌ Servidor ocupado. Por favor espera unos momentos e intenta de nuevo.");
    }
    await liberarUsuario(id, ctx);
    sesiones.recarga.set(id, { paso: 1 });

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

            return enviarLimpio(
                ctx,
                `📋 **CONFIRMACIÓN DE RECARGA**\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `💰 **Monto:** $${MONTO_TELCEL} MXN\n` +
                `📱 **Número:** \`${numero}\`\n` +
                `👤 **Titular:** ${nombre}\n` +
                `💳 **Tarjeta:** \`****${cc.slice(-4)}\`\n` +
                `📅 **Vence:** ${mes}/${anio}\n` +
                `🔒 **CVV:** ***\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `¿Deseas procesar la recarga ahora?`,
                Markup.inlineKeyboard([
                    [Markup.button.callback("✅ SÍ, PAGAR", "pagarTelcel")],
                    [Markup.button.callback("❌ CANCELAR", "cancelaTelcel")]
                ])
            );
        }
    }

    // Flujo interactivo paso a paso
    await enviarLimpio(
        ctx,
        `💰 **RECARGA TELCEL $${MONTO_TELCEL} MXN**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📲 **PASO 1:** Escribe tu número celular a 10 dígitos:\n` +
        `Ejemplo: \`5512345678\``,
        Markup.removeKeyboard()
    );
});

// 🎬 COMANDO /netflix (MENÚ NETFLIX)
bot.command('netflix', async ctx => {
    const id = ctx.chat?.id || ctx.from?.id;
    if (!tieneCupo(id)) {
        return enviarLimpio(ctx, "❌ Servidor ocupado. Por favor espera unos momentos e intenta de nuevo.");
    }
    if (sesiones.recarga.has(id)) {
        await enviarLimpio(ctx, "❌ Termina la recarga primero o usa /reset para cancelar.");
        return;
    }
    sesiones.netflix.set(id, { paso: 'menu_netflix' });

    await enviarLimpio(
        ctx,
        `🎬 **NETFLIX PREMIUM MÉXICO**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Elige el método de datos para tu cuenta:`,
        Markup.inlineKeyboard([
            [Markup.button.callback("🎲 Modo Automático", "netAuto")],
            [Markup.button.callback("✍️ Modo Personalizado", "netPerso")]
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

    await enviarLimpio(
        ctx,
        `🎲 **MODO AUTOMÁTICO ACTIVADO**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📧 **Correo:** \`${correo}\`\n` +
        `🔑 **Contraseña:** \`${pass}\`\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `💳 **Envía tus datos de tarjeta en este formato:**\n` +
        `👉 \`TARJETA|MM|AAAA|CVV\`\n\n` +
        `Ejemplo:\n` +
        `\`4111111111111111|12|2028|123\``
    );
});

// 🎬 OPCIÓN 2: PERSONALIZADO
bot.action(['netflixPersonal', 'netPerso'], async ctx => {
    const id = ctx.from.id;
    await ctx.answerCbQuery().catch(() => {});
    sesionesUsuario.set(id, { modo: 'manual', paso: 'pedirCorreoPersonal', correo: null, pass: null });
    await enviarLimpio(
        ctx,
        `✍️ **MODO PERSONALIZADO**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📝 Por favor, escribe el **CORREO ELECTRÓNICO** que deseas usar:`
    );
});

bot.action(['cancelarNetflix', 'cancelaNetflix'], async ctx => {
    await limpiarSesion(ctx);
    await enviarLimpio(ctx, "❌ **Proceso Netflix cancelado.** Escribe /start para reiniciar.");
});

// 🌐 FUNCIÓN UNIVERSAL PARA LANZAR NAVEGADOR DIRECTO (SIN PROXY)
async function lanzarNavegador({ id, slowMo = 50, geolocation = null }) {
    console.log("🌐 Abriendo navegador...");
    const argsBase = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // 🎯 CLAVE EN RENDER / CONTENEDORES
        '--disable-gpu',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-web-security',
        '--disable-blink-features=AutomationControlled',
        '--lang=es-MX'
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
        timezoneId: 'America/Mexico_City',
        geolocation: geolocation || { latitude: 19.4326, longitude: -99.1332 },
        permissions: ['geolocation'],
        extraHTTPHeaders: {
            'Accept-Language': 'es-MX,es;q=0.9',
            'Referer': 'https://netflix.com/mx/'
        },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    };

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
    // 🧹 Eliminar botones virtuales inmediatamente para evitar dobles clics
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

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

    flujoTelcelIndependiente(ctx, id, { numero, cc, mes, anio, cvv, nombre }).catch(err => {
        console.error(`[Telcel Usuario ${id}] Error en ejecución:`, err.message || err);
    });
});

// 🔄 HANDLER PARA NUEVA RECARGA
// 🔄 HANDLER PARA NUEVA RECARGA
bot.action('nueva_recarga_telcel', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    const id = ctx.chat?.id || ctx.from?.id;
    await liberarUsuario(id, ctx);
    sesiones.recarga.set(id, { paso: 1 });
    await ctx.reply(
        `💰 RECARGA TELCEL $${MONTO_TELCEL} MXN\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📲 Escribe el NÚMERO TELCEL a 10 dígitos o envía todo en una línea:\n` +
        `👉 /recarga 5512345678 4111111111111111|12|2028|123`,
        Markup.removeKeyboard()
    );
});

// 🔄 HANDLER PARA NUEVA CUENTA NETFLIX
bot.action('nueva_cuenta_netflix', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    const id = ctx.chat?.id || ctx.from?.id;
    await liberarUsuario(id, ctx);
    sesiones.netflix.set(id, { paso: 'menu_netflix' });
    await ctx.reply(
        '🎬 NETFLIX: ¿Cómo deseas crear la cuenta? 👇\n' +
        '━━━━━━━━━━━━━━━━\n' +
        'Elige el método de datos:',
        Markup.inlineKeyboard([
            [Markup.button.callback("🎲 Automático", "netAuto")],
            [Markup.button.callback("✍️ Personalizado", "netPerso")]
        ])
    );
});

// 🎯 MAPEO CENTRALIZADO Y SEGURO DE SELECTORES (AUTOPROTECCIÓN)
function locatorSeguro(pagina, clave) {
    const mapaSelectores = {
        botonPermitir: 'button:has-text("Permitir mientras visito el sitio"), button:has-text("Permitir ubicación"), button:has-text("Permitir"), button:has-text("Aceptar"), button:has-text("Acepto"), button:has-text("Entendido")',
        // Paso 1: Ver más paquetes
        botonVerMas: 'button:has(p:has-text("Ver más paquetes")), button:has-text("Ver más paquetes"), button.border-fuchsia-800, div[role="button"]:has-text("Ver más paquetes"), svg[viewBox="0 0 24 24"]',
        // Paso 2: Lo quiero de $200
        paquete200: 'text="Amigo Sin Límite $200", text="$200"',
        botonLoQuiero200: 'b.Plan_buttonPackageLabel__xB_jv, .Plan_buttonPackage__SY6E2, b:has-text("Lo quiero"), div:has-text("Amigo Sin Límite $200") b:has-text("Lo quiero"), div:has-text("$200") b:has-text("Lo quiero"), button:has-text("Lo quiero")',
        // Paso 3: Número celular 10 dígitos (input#id-phone-p)
        telefono: 'input#id-phone-p, input#id-phone, section:has(h2:has-text("Número celular")) input, input[type="tel"][name="phone"], input[type="tel"]',
        // Paso 4: Botón Continuar activado morado
        botonContinuarTel: 'button.fontBoldAMX:has-text("Continuar"), button.bg-\[\#7b1fa2\]:has-text("Continuar"), button:has-text("Continuar"), button[type="submit"]',
        // Paso 5: 16 dígitos tarjeta (input#creditCardNumber)
        tarjeta: 'input#creditCardNumber, input[placeholder*="16 dígitos" i], input[name="cardNumber"][inputmode="numeric"], input[name="cardNumber"]',
        // Paso 6: Nombre del titular (input#creditCardName)
        nombreTitular: 'input#creditCardName, input[placeholder*="Nombre completo" i], input[name="cardHolderName"]',
        // Paso 7: Mes MM (input#month)
        mes: 'input#month, input.exp[placeholder="MM"], input[placeholder="MM"]',
        // Paso 9: Año AA (input#year)
        anio: 'input#year, input.exp[placeholder="AA"], input[placeholder="AA"]',
        fechaExpiracion: 'input[name="cardExpiry"][placeholder="MM / AA"], input[placeholder*="MM / AA" i], input[placeholder*="MM/AA" i]',
        // Paso 10: CVV 000 (input#cvv-input)
        cvv: 'input#cvv-input, input[placeholder="000"], input[name="cardCvv"], input[placeholder*="CVV" i]',
        // Paso 11 & 12: Botón Continuar / Continuar con mi tarjeta física
        botonTarjetaFisica: 'button.ModalInvitation_buttonModal__42s7X, button:has-text("Continuar con mi tarjeta física"), button:has-text("tarjeta física")',
        terminos: 'input[type="checkbox"]#terms, input[type="checkbox"][name*="terms" i], label[for*="terms" i], input[type="checkbox"]',
        botonPagar: 'button[type="submit"].bg-\[\#7b1fa2\]:has-text("Continuar"), button[type="submit"]:has-text("Continuar"), button.fontBoldAMX:has-text("Continuar"), button:has-text("Continuar"), button:has-text("Pagar")'
    };

    const selector = mapaSelectores[clave] || clave;
    return pagina.locator(selector);
}

// 🧼 LIMPIEZA TOTAL Y REINICIO (AUTOPROTECCIÓN DE MEMORIA)
async function limpiarTodoYReiniciar(id, ctx, sesion = null) {
    if (sesion) {
        await cerrarSesion(sesion).catch(() => {});
    }
    await liberarUsuario(id, ctx).catch(() => {});
    global.gc?.();
}

// 🔄 ENVOLTORIO DE EJECUCIÓN CON REINTENTO AUTOMÁTICO (HASTA 3 INTENTOS)
async function ejecutarConReintento(fn, intentosMax = 3, id, ctx) {
    let ultimoError = null;
    for (let intento = 1; intento <= intentosMax; intento++) {
        try {
            console.log(`[AutoProtección Usuario ${id}] 🔄 Ejecución intento ${intento}/${intentosMax}`);
            return await fn(intento);
        } catch (error) {
            ultimoError = error;
            console.error(`[AutoProtección Usuario ${id}] ⚠️ Fallo en intento ${intento}/${intentosMax}:`, error.message || error);
            if (intento < intentosMax) {
                await ctx.reply(`⚠️ Reintentando operación (${intento}/${intentosMax}) con navegador limpio...`).catch(() => {});
                await limpiarTodoYReiniciar(id, ctx);
                await esperar(2000, id);
            }
        }
    }
    throw ultimoError;
}

async function flujoTelcelIndependiente(ctx, id, datos) {
    const { numero, cc, mes, anio, cvv, nombre } = datos;

    // Validación estricta de número celular Telcel a 10 dígitos
    if (!numero || !/^\d{10}$/.test(numero)) {
        await limpiarTodoYReiniciar(id, ctx);
        return enviarLimpio(
            ctx,
            "❌ **Número no válido de Telcel** (debe tener exactamente 10 dígitos).\n\n" +
            "🔄 Proceso reiniciado. Por favor vuelve a intentarlo con /recarga"
        );
    }

    try {
        await ejecutarConReintento(async (intento) => {
            const miId = (ejecucionesUsuario.get(id) || 0) + 1;
            ejecucionesUsuario.set(id, miId);

            let navegadorTelcel = null;
            let contexto = null;
            let paginaTelcel = null;
            let cerradoManualmente = false;

            try {
                // ⚡ LANZAMIENTO LIMPIO Y DIRECTO CON GEOLOCALIZACIÓN MÉXICO
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

                paginaTelcel.on('dialog', async dialog => {
                    await dialog.accept().catch(() => {});
                });

                paginaTelcel.on('popup', async popup => {
                    const btn = popup.locator('button:has-text("Permitir mientras visito el sitio"), button:has-text("Permitir ubicación"), button:has-text("Permitir"), button:has-text("Aceptar")').first();
                    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
                        await btn.click({ force: true }).catch(() => {});
                    }
                });

                // 🌐 NAVEGACIÓN A TELCEL
                console.log(`[Telcel Usuario ${id}] 🌐 Abriendo ${URL_TELCEL}...`);
                await navegarSeguro(paginaTelcel, URL_TELCEL, navegadorTelcel);

                await esperar(500, id, miId, paginaTelcel);

                // ✅ Permiso ubicación automático
                const btnPermitir = locatorSeguro(paginaTelcel, "botonPermitir").first();
                if (await btnPermitir.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await btnPermitir.click({ force: true }).catch(() => {});
                    console.log("📍 Permiso de ubicación aceptado automáticamente");
                    await enviarLimpio(ctx, "📍 Permiso de ubicación aceptado");
                    await esperar(400, id, miId);
                }

                // 1) 🔍 PASO 1: VER MÁS PAQUETES
                console.log(`[Telcel Usuario ${id}] 🔍 Paso 1: Clic en 'Ver más paquetes'...`);
                const botonVerMas = locatorSeguro(paginaTelcel, "botonVerMas").first();
                if (await botonVerMas.isVisible({ timeout: 15000 }).catch(() => false)) {
                    await botonVerMas.scrollIntoViewIfNeeded().catch(() => {});
                    await botonVerMas.click({ force: true }).catch(() => {});
                    console.log(`[Telcel Usuario ${id}] 📜 Clic en 'Ver más paquetes' ejecutado`);
                }
                await paginaTelcel.waitForSelector('text="Amigo Sin Límite $200", text="$200"', { timeout: 40000 }).catch(() => {});
                await esperar(1500, id, miId);

                // 2) 🔍 PASO 2: DAR CLIC EN 'LO QUIERO' ($200)
                console.log(`[Telcel Usuario ${id}] 🔍 Paso 2: Clic en 'Lo quiero' ($200)...`);
                const card200Loc = paginaTelcel.locator('div, section, article, li, mat-card').filter({ hasText: '200' });
                const btn200Loc = card200Loc.locator('b.Plan_buttonPackageLabel__xB_jv, .Plan_buttonPackage__SY6E2, button, a, [role="button"], b').filter({ hasText: /lo quiero|comprar|elegir|recargar/i }).first();
                if (await btn200Loc.isVisible({ timeout: 4000 }).catch(() => false)) {
                    await btn200Loc.scrollIntoViewIfNeeded().catch(() => {});
                    await btn200Loc.click({ force: true, timeout: 5000 }).catch(() => {});
                    console.log(`[Telcel Usuario ${id}] ✅ Clic en botón 'Lo quiero' de $200 ejecutado`);
                } else {
                    await paginaTelcel.evaluate(() => {
                        const elementos = Array.from(document.querySelectorAll('*'));
                        const nodos200 = elementos.filter(el => (el.innerText || '').includes('Amigo Sin Límite $200') || (el.innerText || '').includes('$200'));
                        for (const nodo of nodos200.reverse()) {
                            const btn = nodo.querySelector('b.Plan_buttonPackageLabel__xB_jv, .Plan_buttonPackage__SY6E2, button, a, [role="button"], b, div[class*="btn"]') ||
                                        nodo.closest('div, section, article, li')?.querySelector('b.Plan_buttonPackageLabel__xB_jv, .Plan_buttonPackage__SY6E2, button, a, [role="button"], b, div[class*="btn"]');
                            if (btn && (btn.innerText || '').toLowerCase().includes('quiero')) {
                                btn.scrollIntoView({ block: 'center' });
                                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
                                    btn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
                                });
                                if (typeof btn.click === 'function') btn.click();
                                return true;
                            }
                        }
                        return false;
                    }).catch(() => false);
                }

                await enviarLimpio(ctx, "✅ **PAQUETE $200 SELECCIONADO**\nIngresando número celular...");

                // 3) 📱 PASO 3: DAR CLIC Y LLENAR NÚMERO A 10 DÍGITOS (input#id-phone-p)
                const campoTel = locatorSeguro(paginaTelcel, "telefono").first();
                try {
                    await campoTel.waitFor({ state: "visible", timeout: 35000 });
                } catch(eWaitTel) {
                    console.error(`[Telcel Diagnóstico] Timeout en campo teléfono. URL: ${paginaTelcel.url()} | Título: ${await paginaTelcel.title().catch(() => '')}`);
                    throw eWaitTel;
                }

                await campoTel.scrollIntoViewIfNeeded().catch(() => {});
                await campoTel.click({ force: true });
                await campoTel.fill('', { force: true });
                await campoTel.fill(numero, { force: true });
                await campoTel.dispatchEvent('input', { bubbles: true }).catch(() => {});
                await campoTel.dispatchEvent('change', { bubbles: true }).catch(() => {});
                await campoTel.dispatchEvent('blur', { bubbles: true }).catch(() => {});

                // Detectar cambio de value y validar que coincida con el número ingresado
                let valorTelEscrito = await campoTel.inputValue().catch(() => '');
                if (valorTelEscrito !== numero) {
                    await campoTel.fill(numero, { force: true });
                    await campoTel.dispatchEvent('input', { bubbles: true }).catch(() => {});
                    await campoTel.dispatchEvent('change', { bubbles: true }).catch(() => {});
                    valorTelEscrito = await campoTel.inputValue().catch(() => '');
                }

                if (valorTelEscrito.length !== 10) {
                    throw new Error("El número ingresado no es válido para Telcel (no tiene 10 dígitos)");
                }

                // 4) 🟣 PASO 4: DAR CLIC EN CONTINUAR (BOTÓN MORADO ACTIVADO)
                const btnContinuarTel = locatorSeguro(paginaTelcel, "botonContinuarTel").first();
                if (await btnContinuarTel.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await btnContinuarTel.click({ force: true }).catch(() => {});
                } else {
                    await paginaTelcel.getByRole('button', { name: /continuar|siguiente/i }).first().click({ force: true }).catch(() => {});
                }
                await enviarLimpio(ctx, "📱 **NÚMERO INGRESADO**\nLlenando datos de tarjeta...");

                // 5) 💳 PASO 5: INTRODUCIR 16 DÍGITOS DE TARJETA (input#creditCardNumber)
                await enviarLimpio(ctx, "📝 **Llenando datos de tarjeta...**");

                const inputCC = locatorSeguro(paginaTelcel, "tarjeta").first();
                await inputCC.waitFor({ state: 'visible', timeout: 25000 });
                await inputCC.scrollIntoViewIfNeeded().catch(() => {});
                await inputCC.click({ force: true });
                await inputCC.fill('', { force: true });
                await inputCC.fill(cc, { force: true });
                await inputCC.dispatchEvent('input', { bubbles: true }).catch(() => {});
                await inputCC.dispatchEvent('change', { bubbles: true }).catch(() => {});
                await inputCC.dispatchEvent('blur', { bubbles: true }).catch(() => {});

                // 6) 👤 PASO 6: INTRODUCIR NOMBRE (input#creditCardName)
                console.log(`[Telcel] Llenando nombre del titular: ${nombre}`);
                const inputNom = locatorSeguro(paginaTelcel, "nombreTitular").first();
                await inputNom.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
                await inputNom.scrollIntoViewIfNeeded().catch(() => {});
                await inputNom.click({ force: true }).catch(() => {});
                await inputNom.fill('', { force: true }).catch(() => {});
                await inputNom.fill(nombre, { force: true }).catch(() => {});
                await inputNom.dispatchEvent('input', { bubbles: true }).catch(() => {});
                await inputNom.dispatchEvent('change', { bubbles: true }).catch(() => {});
                await inputNom.dispatchEvent('blur', { bubbles: true }).catch(() => {});

                // 7 & 8 & 9) 📅 PASO 7, 8, 9: INTRODUCIR MES (input#month), / Y AÑO (input#year)
                const inputMes = locatorSeguro(paginaTelcel, "mes").first();
                const inputAnio = locatorSeguro(paginaTelcel, "anio").first();
                const inputFecha = locatorSeguro(paginaTelcel, "fechaExpiracion").first();

                const mesSeparado = await inputMes.isVisible({ timeout: 2000 }).catch(() => false);
                if (mesSeparado) {
                    await inputMes.click({ force: true });
                    await inputMes.fill('', { force: true });
                    await inputMes.fill(mes, { force: true });
                    await inputMes.dispatchEvent('input', { bubbles: true }).catch(() => {});
                    await inputMes.dispatchEvent('change', { bubbles: true }).catch(() => {});

                    if (await inputAnio.isVisible({ timeout: 2000 }).catch(() => false)) {
                        await inputAnio.click({ force: true });
                        await inputAnio.fill('', { force: true });
                        await inputAnio.fill(anio.slice(-2), { force: true });
                        await inputAnio.dispatchEvent('input', { bubbles: true }).catch(() => {});
                        await inputAnio.dispatchEvent('change', { bubbles: true }).catch(() => {});
                    }
                } else {
                    if (await inputFecha.isVisible({ timeout: 3000 }).catch(() => false)) {
                        await inputFecha.click({ force: true });
                        await inputFecha.fill('', { force: true });
                        const fechaFormateada = `${mes}/${anio.slice(-2)}`;
                        await inputFecha.fill(fechaFormateada, { force: true });
                        await inputFecha.dispatchEvent('input', { bubbles: true }).catch(() => {});
                        await inputFecha.dispatchEvent('change', { bubbles: true }).catch(() => {});
                        await inputFecha.dispatchEvent('blur', { bubbles: true }).catch(() => {});
                    }
                }

                // 10) 🔒 PASO 10: INTRODUCIR CVV (input#cvv-input)
                const inputCvv = locatorSeguro(paginaTelcel, "cvv").first();
                if (await inputCvv.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await inputCvv.click({ force: true });
                    await inputCvv.fill('', { force: true });
                    await inputCvv.fill(cvv, { force: true });
                    await inputCvv.dispatchEvent('input', { bubbles: true }).catch(() => {});
                    await inputCvv.dispatchEvent('change', { bubbles: true }).catch(() => {});
                    await inputCvv.dispatchEvent('blur', { bubbles: true }).catch(() => {});
                }

                // Aceptar Términos si existen
                const checkboxTerms = locatorSeguro(paginaTelcel, "terminos").first();
                if (await checkboxTerms.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await checkboxTerms.scrollIntoViewIfNeeded().catch(() => {});
                    await checkboxTerms.check({ force: true }).catch(() => {
                        return checkboxTerms.click({ force: true });
                    });
                }

                // Forzar validación React de todos los inputs
                await paginaTelcel.evaluate(() => {
                    document.querySelectorAll('input').forEach(input => {
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        input.dispatchEvent(new Event('blur', { bubbles: true }));
                    });
                }).catch(() => {});

                await enviarLimpio(ctx, "💳 **DATOS LLENOS → PROCESANDO PAGO...**");

                // 11) 🚀 PASO 11: DETECTAR BOTÓN CONTINUAR ACTIVADO Y DAR CLIC
                await paginaTelcel.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button'));
                    const b = btns.reverse().find(el => (el.innerText || '').includes('Continuar') || (el.innerText || '').includes('Pagar'));
                    if (b) { 
                        b.removeAttribute('disabled'); 
                        b.style.pointerEvents = 'auto'; 
                    }
                }).catch(() => {});

                const btnContinuar = locatorSeguro(paginaTelcel, "botonPagar").last();
                await btnContinuar.scrollIntoViewIfNeeded().catch(() => {});
                await esperar(500, id, miId);
                await btnContinuar.click({ force: true }).catch(() => {});
                console.log("✅ CLIC EN BOTÓN 'CONTINUAR' EJECUTADO");

                // 12) 💳 PASO 12: SI APARECE MODAL, CLIC EN 'Continuar con mi tarjeta física'
                await esperar(1200, id, miId);
                const btnFisica = locatorSeguro(paginaTelcel, "botonTarjetaFisica").first();
                if (await btnFisica.isVisible({ timeout: 3500 }).catch(() => false)) {
                    await btnFisica.scrollIntoViewIfNeeded().catch(() => {});
                    await btnFisica.click({ force: true }).catch(() => {});
                    console.log(`[Telcel Usuario ${id}] ✅ Clic en 'Continuar con mi tarjeta física' ejecutado`);
                }

                await enviarLimpio(ctx, "⌛ **Procesando pago en Telcel Pay...**\nEsperando respuesta final...");

                // 13) 📸 PASO 13: ESPERA ACTIVA, ENVÍO DE CAPTURA Y CIERRE LIMPIO
                let tipoPantalla = "DESCONOCIDO";
                let resultadoTexto = "PROCESO FINALIZADO";
                const inicioEspera = Date.now();
                const TIEMPO_MAX_ESPERA = 90000;

                while (Date.now() - inicioEspera < TIEMPO_MAX_ESPERA) {
                    const textoPagina = await paginaTelcel.evaluate(() => {
                        return (document.body ? document.body.innerText : '') || '';
                    }).catch(() => '');

                    if (/(pago\s*exitoso)|(transacci[óo]n\s*exitosa)|(recarga\s*exitosa)|(¡listo!)|(folio:)|(folio\s*\d+)|(comprobante)|(ticket)|(aprobada)|(gracias\s*por\s*tu\s*compra)|(tu\s*pago\s*ha\s*sido\s*(exitoso|procesado|aprobado))|(tu\s*recarga\s*fue\s*exitosa)/i.test(textoPagina)) {
                        tipoPantalla = "PAGO_EXITOSO";
                        resultadoTexto = "✅ PAGO EXITOSO / APROBADO";
                        break;
                    }

                    if (/(bin\s*(inv[áa]lido|no\s*v[áa]lido|no\s*soportado))|(tarjeta\s*(inv[áa]lida|no\s*v[áa]lida|no\s*soportada|no\s*aceptada|no\s*reconocida))|(n[úu]mero\s*de\s*tarjeta\s*inv[áa]lido)|(emisor\s*no\s*soportado)|(tipo\s*de\s*tarjeta\s*no\s*v[áa]lida)|(revisa\s*el\s*n[úu]mero\s*de\s*tarjeta)|(tarjeta\s*no\s*permitida)/i.test(textoPagina)) {
                        tipoPantalla = "BIN_INVALIDO";
                        resultadoTexto = "🚫 BIN / TARJETA INVÁLIDA";
                        break;
                    }

                    if (/(tu\s*solicitud\s*no\s*pudo\s*ser\s*(completada|procesada))|(no\s*se\s*pudo\s*realizar\s*(el\s*pago|la\s*operaci[óo]n))|(transacci[óo]n\s*declinada)|(pago\s*rechazado)|(tarjeta\s*rechazada)|(fondos\s*insuficientes)|(error\s*al\s*procesar)|(intenta\s*con\s*otra\s*tarjeta)|(operaci[óo]n\s*no\s*exitosa)|(hubo\s*un\s*problema\s*al\s*procesar)|(no\s*autorizada)|(rechazada\s*por\s*el\s*banco)/i.test(textoPagina)) {
                        tipoPantalla = "SOLICITUD_NO_COMPLETADA";
                        resultadoTexto = "❌ TU SOLICITUD NO PUDO SER COMPLETADA";
                        break;
                    }

                    await esperar(2000, id, miId, paginaTelcel);
                }

                if (tipoPantalla === "DESCONOCIDO") {
                    resultadoTexto = "⌛ RESPUESTA DE TELCEL EN PANTALLA";
                }

                await esperar(1500, id, miId, paginaTelcel);

                // Captura de pantalla y envío limpio
                const captura = await paginaTelcel.screenshot({ fullPage: true }).catch(() => null);
                const fechaHora = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });

                if (miId === ejecucionesUsuario.get(id)) {
                    let mensajeCaption = '';
                    if (tipoPantalla === "PAGO_EXITOSO") {
                        mensajeCaption = 
                            `✅ **RECARGA FINALIZADA CON ÉXITO** ✅\n\n` +
                            `📅 Fecha: ${fechaHora}\n` +
                            `💰 Monto: $${MONTO_TELCEL} MXN\n` +
                            `📱 Número: \`${numero}\`\n` +
                            `👤 Titular: ${nombre}\n` +
                            `💳 Tarjeta: ****${cc.slice(-4)}`;
                    } else if (tipoPantalla === "BIN_INVALIDO") {
                        mensajeCaption = 
                            `❌ **NO SE COMPLETÓ EL PROCESO** ❌\n\n` +
                            `💬 Motivo: BIN o tarjeta no admitida por Telcel\n` +
                            `💳 Tarjeta: ****${cc.slice(-4)}\n` +
                            `🔄 Instrucción: Por favor intenta nuevamente con otra tarjeta.`;
                    } else if (tipoPantalla === "SOLICITUD_NO_COMPLETADA") {
                        mensajeCaption = 
                            `❌ **NO SE COMPLETÓ EL PROCESO** ❌\n\n` +
                            `💬 Motivo: Telcel no pudo completar la solicitud de pago\n` +
                            `💳 Tarjeta: ****${cc.slice(-4)}\n` +
                            `🔄 Instrucción: Por favor intenta nuevamente más tarde.`;
                    } else {
                        mensajeCaption = 
                            `📸 **ESTADO DE LA OPERACIÓN**\n\n` +
                            `📅 Fecha: ${fechaHora}\n` +
                            `📱 Número: \`${numero}\`\n` +
                            `💳 Tarjeta: ****${cc.slice(-4)}`;
                    }

                    if (captura) {
                        await enviarFotoLimpia(
                            ctx,
                            { source: captura },
                            {
                                caption: mensajeCaption.slice(0, 1024),
                                ...Markup.inlineKeyboard([
                                    [Markup.button.callback('📱 Nueva Recarga Telcel', 'nueva_recarga_telcel')],
                                    [Markup.button.callback('❌ Salir', 'cancelar_accion')]
                                ])
                            }
                        );
                    } else {
                        await enviarLimpio(
                            ctx,
                            mensajeCaption,
                            Markup.inlineKeyboard([
                                [Markup.button.callback('📱 Nueva Recarga Telcel', 'nueva_recarga_telcel')],
                                [Markup.button.callback('❌ Salir', 'cancelar_accion')]
                            ])
                        );
                    }
                }

                // ⏱️ Espera antes de cerrar
                console.log(`[Telcel Usuario ${id}] ⏳ Esperando 20 segundos antes de cerrar el navegador...`);
                await esperar(20000, id, miId, paginaTelcel).catch(() => {});

                return true;

            } finally {
                await limpiarTodoYReiniciar(id, ctx, { pagina: paginaTelcel, ctx: contexto, nav: navegadorTelcel });
                console.log(`[Telcel Usuario ${id}] 🧹 Estado y navegador liberados al 100%.`);
            }
        }, 3, id, ctx);

    } catch(errTelcel) {
        console.error(`[Telcel Usuario ${id}] ❌ Fallo total tras reintentos:`, errTelcel.message || errTelcel);
        await enviarLimpio(
            ctx,
            `❌ **NO SE PUDO COMPLETAR EL PROCESO TRAS 3 INTENTOS** ❌\n\n` +
            `💬 Motivo: ${(errTelcel.message || 'Error inesperado').slice(0, 150)}\n\n` +
            `🔄 Sesión y memoria reseteadas al 100%.`,
            Markup.inlineKeyboard([
                [Markup.button.callback('📱 Intentar Nueva Recarga', 'nueva_recarga_telcel')],
                [Markup.button.callback('❌ Salir', 'cancelar_accion')]
            ])
        );
    } finally {
        await limpiarTodoYReiniciar(id, ctx);
    }
}

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
    await enviarLimpio(
        ctx,
        `🚀 **INICIANDO REGISTRO NETFLIX**\n\n` +
        `📧 **Email:** \`${cuenta.correo}\`\n` +
        `🔑 **Contraseña:** \`${cuenta.pass}\`\n` +
        `👤 **Titular:** ${cuenta.nombreCompleto}\n` +
        `💳 **Tarjeta:** \`****${cuenta.tarjeta.slice(-4)}\`\n` +
        `⚙️ **Modo:** ${cuenta.esPersonalizado ? "Personalizado" : "Aleatorio"}\n\n` +
        `⏳ Procesando cuenta en segundo plano... Te avisaré al finalizar.`
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
        for (let reintento = 1; reintento <= 8; reintento++) {
            if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");

            // Si hay botón Siguiente / Continuar intermedio
            const btnIntermedio = pagina.locator('button:has-text("Siguiente"), button:has-text("Continuar"), a:has-text("Siguiente"), a:has-text("Continuar")').first();
            if (await btnIntermedio.isVisible({timeout:1200}).catch(() => false)) {
                await btnIntermedio.scrollIntoViewIfNeeded().catch(() => {});
                await btnIntermedio.click({force:true}).catch(() => {});
                await esperar(1500, usuarioId, miId);
            }

            // Omitir pantallas secundarias si reaparecen
            await gestionarOmitirVerificacionEmail();
            await gestionarTelefonoSiAparece();

            // Selectores oficiales y flexibles para la opción de Tarjeta
            const selectoresOpcionTarjeta = [
                'a[data-uia="payment-choice-creditOption"]',
                'a[data-uia*="creditOption"]',
                'a[href*="creditOption"]',
                'button[data-uia*="creditOption"]',
                '[data-uia="creditOption-link"]',
                '[data-uia*="credit"]',
                'a:has-text("Tarjeta de crédito o débito")',
                'button:has-text("Tarjeta de crédito o débito")',
                'div[data-layout="item"]:has-text("Tarjeta")',
                'div:has-text("Tarjeta de crédito o débito")',
                'text="Tarjeta de crédito o débito"'
            ];

            for (const sel of selectoresOpcionTarjeta) {
                const loc = pagina.locator(sel).first();
                if (await loc.isVisible({timeout:600}).catch(() => false)) {
                    await loc.scrollIntoViewIfNeeded().catch(() => {});
                    await loc.click({force:true}).catch(() => {});
                    seleccionoTarjeta = true;
                    break;
                }
            }

            // Respaldo DOM agresivo buscando enlace/botón de Tarjeta
            await pagina.evaluate(() => {
                const elementos = Array.from(document.querySelectorAll('a, button, [role="button"], div[data-layout="item"], div'));
                const tarjetaLink = elementos.find(el => {
                    const t = (el.textContent || '').trim();
                    const uia = el.getAttribute('data-uia') || '';
                    const href = el.getAttribute('href') || '';
                    return uia.includes('creditOption') || href.includes('creditOption') || t.includes('Tarjeta de crédito o débito') || (t.includes('Tarjeta') && t.includes('débito'));
                });
                if (tarjetaLink) {
                    const contenedor = tarjetaLink.closest('a, button, [role="button"]') || tarjetaLink;
                    contenedor.scrollIntoView({ block: 'center' });
                    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
                        contenedor.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
                    });
                    if (typeof contenedor.click === 'function') contenedor.click();
                }
            }).catch(() => {});

            await esperar(2000, usuarioId, miId);

            // Comprobar si ya estamos en el formulario con el campo de tarjeta
            const inputNumTest = pagina.locator('input[data-uia*="creditCardNumber"], input[name*="creditCardNumber"], input[name*="cardNumber"], input[id*="creditCardNumber"], input[placeholder*="Número"], input[placeholder*="Card number"]').first();
            if (await inputNumTest.isVisible({timeout:2000}).catch(() => false)) {
                console.log(`[Usuario ${usuarioId}] ✅ Formulario de tarjeta detectado en pantalla.`);
                break;
            }
        }

        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        await esperar(2000, usuarioId, miId);

        // 📝 10. LLENADO DE DATOS DE LA TARJETA
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        console.log("🔎 PASO 7: Llenando datos de tarjeta...");

        // 1. Número de Tarjeta con selector múltiple oficial
        const selectorNumTarjeta = [
            'input[data-uia="field-creditCardNumber"]',
            'input[data-uia*="creditCardNumber"]',
            'input[name="creditCardNumber"]',
            'input[name="cardNumber"]',
            'input[id="id_creditCardNumber"]',
            'input[id*="creditCardNumber"]',
            'input[autocomplete="cc-number"]',
            'input[placeholder*="Número de tarjeta" i]',
            'input[placeholder*="Número" i]',
            'input[placeholder*="Card number" i]',
            'input[type="tel"]'
        ].join(', ');

        const num = pagina.locator(selectorNumTarjeta).first();
        try {
            await num.waitFor({state:'visible', timeout:20000});
        } catch(eNum) {
            console.error(`[Netflix Diagnóstico] Timeout en campo tarjeta. URL: ${pagina.url()} | Título: ${await pagina.title().catch(() => '')}`);
            await tomarCapturaError("No apareció campo de número de tarjeta");
            throw eNum;
        }
        await num.scrollIntoViewIfNeeded().catch(() => {});
        await num.click({force:true});
        await num.fill('', {force:true});
        await num.type(cuenta.tarjeta, {delay: aleatorio(60, 90), force:true});
        console.log(`[Usuario ${usuarioId}] ✅ Número de tarjeta ingresado`);

        // 2. Fecha de Vencimiento (Regla: Limpiar primero -> MM/AA directo todo de golpe -> force: true)
        if (miId !== ejecucionesUsuario.get(usuarioId)) throw new Error("PROCESO_REINICIADO");
        const fecha = pagina.locator('input[name="expiryDate"], input[name="creditExpirationMonth"], input[id*="creditExpirationMonth"], input[data-uia*="creditExpirationMonth"], input[autocomplete="cc-exp"], input[placeholder*="MM / AA"], input[placeholder*="MM/AA"], input[placeholder*="MM"], input[placeholder*="Vencimiento"]').first();
        if (await fecha.isVisible({timeout:4000}).catch(() => false)) {
            await fecha.scrollIntoViewIfNeeded().catch(() => {});
            await fecha.click({force:true});
            await fecha.fill('', {force:true});
            const anioCorto = cuenta.anio.length === 4 ? cuenta.anio.slice(-2) : cuenta.anio;
            const fechaFormateada = `${cuenta.mes}/${anioCorto}`;
            await fecha.fill(fechaFormateada, {force:true});
            await fecha.dispatchEvent('input', { bubbles: true }).catch(() => {});
            await fecha.dispatchEvent('change', { bubbles: true }).catch(() => {});
            console.log(`[Usuario ${usuarioId}] ✅ Fecha de vencimiento ingresada (${fechaFormateada})`);
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
                    await enviarFotoLimpia(
                        ctx,
                        { source: capturaError },
                        {
                            caption:
                                "❌ **NO SE PUDO PROCESAR EL PAGO**\n\n" +
                                "⚠️ Netflix no pudo procesar esta tarjeta (**" + cuenta.tarjeta.slice(-4) + ").\n" +
                                "💡 Intenta con OTRA tarjeta.\n\n" +
                                "🔄 Sesión reiniciada. Escribe /start para volver a empezar."
                        }
                    );
                } else {
                    await enviarLimpio(
                        ctx,
                        "❌ **NO SE PUDO PROCESAR EL PAGO**\n\n" +
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
                await enviarFotoLimpia(
                    ctx,
                    { source: capturaExito },
                    {
                        caption:
                            "🎉 **¡CUENTA NETFLIX ACREDITADA CON ÉXITO!**\n\n" +
                            "📧 **Correo:** `" + cuenta.correo + "`\n" +
                            "🔑 **Contraseña:** `" + cuenta.pass + "`\n" +
                            "👤 **Titular:** " + cuenta.nombreCompleto + "\n" +
                            "💳 **Tarjeta:** ****" + cuenta.tarjeta.slice(-4) + "\n\n" +
                            "✅ Proceso finalizado y recursos liberados.",
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('🎬 Nueva Cuenta Netflix', 'nueva_cuenta_netflix')],
                            [Markup.button.callback('❌ Salir', 'cancelar_accion')]
                        ])
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
        if (miId === ejecucionesUsuario.get(usuarioId)) {
            let capturaEnviada = false;
            if (pagina && !pagina.isClosed()) {
                const capError = await pagina.screenshot({ fullPage: true }).catch(() => null);
                if (capError) {
                    capturaEnviada = true;
                    await enviarFotoLimpia(
                        ctx,
                        { source: capError },
                        {
                            caption:
                                `❌ **ERROR EN EL PROCESO NETFLIX** ❌\n\n` +
                                `💬 Motivo: ${(err.message || 'Error inesperado').slice(0, 150)}\n` +
                                `📍 URL: ${pagina.url().slice(0, 100)}\n\n` +
                                `🔄 Sesión reseteada automáticamente.`,
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback('🎬 Intentar Nueva Cuenta', 'nueva_cuenta_netflix')],
                                [Markup.button.callback('❌ Salir', 'cancelar_accion')]
                            ])
                        }
                    );
                }
            }
            if (!capturaEnviada) {
                await enviarLimpio(
                    ctx,
                    `❌ **NO SE COMPLETÓ EL PROCESO** ❌\n\n` +
                    `💬 Motivo: ${(err.message || 'Error inesperado').slice(0, 150)}\n\n` +
                    `🔄 Sesión reseteada automáticamente.`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback('🎬 Intentar Nueva Cuenta', 'nueva_cuenta_netflix')],
                        [Markup.button.callback('❌ Salir', 'cancelar_accion')]
                    ])
                );
            }
        }
    } finally {
        // 🧹 RESET Y LIMPIEZA COMPLETA DE RECURSOS EN NAVEGADOR Y MEMORIA
        try {
            if (contexto) {
                await contexto.clearCookies().catch(() => {});
                await contexto.clearPermissions().catch(() => {});
            }
        } catch(eClean) {}

        await limpiarTodoYReiniciar(usuarioId, ctx, { pagina, ctx: contexto, nav: navegador });
        console.log(`[Usuario ${usuarioId}] 🧹 Sesión y navegador reseteados al 100%.`);
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


