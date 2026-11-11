const { Telegraf } = require('telegraf');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Configuración inicial con las nuevas credenciales provistas
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Falta BOT_TOKEN en las variables de entorno');
const ENLACE = process.env.ENLACE || 'https://www.bershka.com/mx/pack-3-calcetines-color-c0p229737233.html?colorId=600';
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || '8508503062';
const ALLOWED_USERS = process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(',') : [];

const bot = new Telegraf(BOT_TOKEN);

// Asegurar que la carpeta data y el archivo usuarios.json existan
const dataDir = path.join(__dirname, 'data');
const usuariosFile = path.join(dataDir, 'usuarios.json');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(usuariosFile)) {
    fs.writeFileSync(usuariosFile, JSON.stringify({ usuarios: [] }, null, 2));
}

// Funciones auxiliares para la base de datos local
function leerDatos() {
    try {
        const data = fs.readFileSync(usuariosFile, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return { usuarios: [] };
    }
}

function guardarDatos(data) {
    fs.writeFileSync(usuariosFile, JSON.stringify(data, null, 2));
}

// Middleware opcional de seguridad (verifica si hay restricciones en ALLOWED_USERS)
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const userId = ctx.from.id.toString();
    
    // Si ALLOWED_USERS está definido y no está vacío, filtrar
    if (ALLOWED_USERS.length > 0 && userId !== ADMIN_TELEGRAM_ID && !ALLOWED_USERS.includes(userId)) {
        return ctx.reply('⛔ No tienes autorización para utilizar este bot.');
    }
    return next();
});

// Comando /start
bot.start((ctx) => {
    ctx.reply(
        '🤖 *Bot de Automatización y Recargas (Telcel / Bait)*\n\n' +
        'Comandos disponibles:\n' +
        '• /check - Ejecuta la verificación automatizada con Playwright en el enlace configurado.\n' +
        '• /recargas - Muestra el desglose completo de todos los registros guardados.',
        { parse_mode: 'Markdown' }
    );
});

// Comando /check (Inspecciona la página / pasarela con Playwright)
bot.command('check', async (ctx) => {
    const statusMsg = await ctx.reply('🔍 Conectando con el enlace y verificando elementos interactivos...');
    let browser;

    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        // Navegar al enlace configurado
        const response = await page.goto(ENLACE, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const statusCode = response ? response.status() : 'Desconocido';
        const pageTitle = await page.title();

        // Extraer elementos interactivos del DOM
        const elementos = await page.evaluate(() => {
            const botones = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'))
                .map(el => el.innerText.trim() || el.value || el.getAttribute('aria-label') || 'Botón');
            const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea'))
                .map(el => el.placeholder || el.name || el.type || 'campo');
            return {
                botones: botones.filter(b => b.length > 0).slice(0, 5),
                totalBotones: botones.length,
                totalInputs: inputs.length
            };
        });

        await browser.close();

        // Registrar la actividad en la base de datos local (usuarios.json)
        const db = leerDatos();
        const nuevoRegistro = {
            id: ctx.from.id,
            username: ctx.from.username || 'Sin usuario',
            fecha: new Date().toISOString(),
            url: ENLACE,
            estado: statusCode,
            titulo: pageTitle || 'Sin título'
        };
        db.usuarios.push(nuevoRegistro);
        guardarDatos(db);

        // Construir el reporte para Telegram
        let reporte = `✅ *Verificación Exitosa (/check)*\n\n`;
        reporte += `📌 *Título:* ${pageTitle || 'Sin título'}\n`;
        reporte += `🔗 *Enlace:* ${ENLACE}\n`;
        reporte += `📡 *Estado HTTP:* ${statusCode}\n`;
        reporte += `🔘 *Botones detectados:* ${elementos.totalBotones}\n`;
        reporte += `📝 *Campos de entrada:* ${elementos.totalInputs}\n\n`;
        reporte += `_✔ Operación registrada y guardada en el sistema._`;

        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, reporte, { parse_mode: 'Markdown' });

    } catch (error) {
        if (browser) await browser.close();
        console.error(error);
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `❌ *Error en /check:*\n\`${error.message}\``, { parse_mode: 'Markdown' });
    }
});

// Comando /recargas (Desglosa todo lo guardado en usuarios.json)
bot.command('recargas', async (ctx) => {
    const db = leerDatos();
    const registros = db.usuarios;

    if (!registros || registros.length === 0) {
        return ctx.reply('📂 *Desglose de Recargas / Registros*:\n\nNo hay elementos guardados en la base de datos todavía.', { parse_mode: 'Markdown' });
    }

    let mensaje = `📂 *Desglose de Registros Guardados* (${registros.length} total):\n\n`;

    registros.forEach((reg, index) => {
        mensaje += `*#${index + 1}*\n`;
        mensaje += `👤 Usuario ID: \`${reg.id}\` (@${reg.username})\n`;
        mensaje += `📅 Fecha: ${reg.fecha}\n`;
        mensaje += `🔗 URL: ${reg.url}\n`;
        mensaje += `📡 Estado: ${reg.estado}\n`;
        mensaje += `-----------------------------------\n`;
    });

    if (mensaje.length > 4000) {
        mensaje = mensaje.substring(0, 3900) + '\n\n... (Lista recortada por límite de caracteres)';
    }

    await ctx.reply(mensaje, { parse_mode: 'Markdown' });
});

// Iniciar el bot en modo polling
bot.launch();
console.log('[Bot Recargas & Check] Iniciado correctamente y escuchando comandos...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
const http = require('http');

// Servidor HTTP básico para satisfacer el requisito de puertos de Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot de Telegram activo y funcionando correctamente.\n');
}).listen(PORT, () => {
    console.log(`[Servidor Web] Escuchando en el puerto ${PORT}`);
});
