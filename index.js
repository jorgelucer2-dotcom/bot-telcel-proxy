'use strict';
require('dotenv').config();
const { Telegraf } = require('telegraf');
const { chromium } = require('playwright');
const fsPromises = require('fs/promises');
const path = require('path');
const http = require('http');

// ==================================================
// 🔑 CONFIGURACIÓN (MANTIENE MÚLTIPLES MONTOS)
// ==================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const PROXY = process.env.PROXY;
const URL_TELCEL = 'https://pay.telcel.com/package/1';
const PUERTO = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("❌ FALTA VARIABLE: BOT_TOKEN");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const sesiones = new Map();
const CARPETA_TMP = path.join(__dirname, 'tmp');

// ==================================================
// ⚙️ FUNCIONES AUXILIARES
// ==================================================
function esperar(ms) { return new Promise(r => setTimeout(r, ms)); }
function ultimos4(dato) { return typeof dato === 'string' ? dato.slice(-4) : '**'; }
function nombreAleatorio() {
  const n = ["Carlos", "María", "Juan", "Ana", "Luis", "Sofía"];
  const a = ["García", "Martínez", "López", "Pérez", "Rodríguez"];
  return `${n[Math.floor(Math.random() * n.length)]} ${a[Math.floor(Math.random() * a.length)]}`;
}

// ==================================================
// 🌐 NAVEGADOR + PROXY MÉXICO
// ==================================================
async function crearNavegador() {
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--start-maximized']
  };

  if (PROXY) {
    launchOptions.proxy = typeof PROXY === 'string' && (PROXY.startsWith('http://') || PROXY.startsWith('https://') || PROXY.startsWith('socks5://'))
      ? { server: PROXY }
      : { server: `http://${PROXY}` };
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    locale: "es-MX",
    geolocation: { latitude: 19.4326, longitude: -99.1332 },
    permissions: ["geolocation"],
    extraHTTPHeaders: { "Accept-Language": "es-MX,es;q=0.9", "Referer": "https://pay.telcel.com/" }
  });
  return { browser, context };
}

// ==================================================
// 🧹 LIMPIEZA TOTAL
// ==================================================
async function limpiarRecursos(idChat, browser, context, page) {
  try {
    if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }).catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (idChat) sesiones.delete(idChat);
    const archivos = await fsPromises.readdir(CARPETA_TMP).catch(() => []);
    for (const f of archivos) {
      if (f.endsWith('.png')) await fsPromises.unlink(path.join(CARPETA_TMP, f)).catch(() => {});
    }
  } catch {}
}

// ==================================================
// 📱 FLUJO: SELECCIÓN MONTO + ASEGURA CLIC EN CONTINUAR
// ==================================================
async function procesarRecarga(ctx, numero, tarjeta, monto = 200) {
  const id = ctx.chat.id;
  let browser, context, page;
  const INTENTOS_MAX = 3;

  for (let intento = 1; intento <= INTENTOS_MAX; intento++) {
    try {
      await ctx.reply(`🔄 RECARGA $${monto} | Intento ${intento}/${INTENTOS_MAX}`);
      ({ browser, context } = await crearNavegador());
      page = await context.newPage();

      // 1. ABRIR TELCEL
      await page.goto(URL_TELCEL, { waitUntil: "domcontentloaded", timeout: 40000 });
      await esperar(1500);

      // Permiso ubicación si aparece
      const btnPermitir = page.locator('button:has-text("Permitir mientras visito el sitio"), button:has-text("Permitir ubicación"), button:has-text("Permitir"), button:has-text("Aceptar")').first();
      if (await btnPermitir.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btnPermitir.click({ force: true }).catch(() => {});
      }

      // 2. VER MÁS PAQUETES
      const btnVerMas = page.locator('button:has(p:has-text("Ver más paquetes")), button:has-text("Ver más paquetes")');
      await btnVerMas.waitFor({ state: "visible", timeout: 15000 });
      await btnVerMas.click();

      // 3. SELECCIONAR PAQUETE ($200 / $300 / $500) ✅ SELECCIÓN POR TEXTO
      const regexCosto = new RegExp(`^\\$?\\s*${monto}$`, 'i');
      const tarjetaPaquete = page.locator('div.Plan_package__zO1Ss, div[class*="Plan_package__"]')
        .filter({ has: page.locator('b.Plan_b__DrgD_, [class*="Plan_b__"]').filter({ hasText: regexCosto }) })
        .filter({ has: page.locator('b.Plan_buttonPackageLabel__xB_jv, b:has-text("Lo quiero")') });

      await tarjetaPaquete.waitFor({ state: "attached", timeout: 20000 });
      const conteo = await tarjetaPaquete.count().catch(() => 0);
      if (conteo === 0) throw new Error(`PAQUETE_$${monto}_NO_ENCONTRADO`);

      const btnLoQuiero = tarjetaPaquete.locator('b.Plan_buttonPackageLabel__xB_jv, b:has-text("Lo quiero")');
      await btnLoQuiero.scrollIntoViewIfNeeded();
      await btnLoQuiero.waitFor({ state: "visible", timeout: 15000 });
      await btnLoQuiero.click();

      // 4. NÚMERO TELCEL
      await page.waitForSelector('h2:has-text("Número celular"), div:has-text("Número celular")', { state: "visible", timeout: 20000 }).catch(() => {});
      const inputNumero = page.locator('input#id-phone-p');
      await inputNumero.waitFor({ state: "visible", timeout: 15000 });
      if (!/^\d{10}$/.test(numero)) throw new Error("Número inválido (10 dígitos)");
      await inputNumero.fill(numero);
      await inputNumero.dispatchEvent('input', { bubbles: true }).catch(() => {});
      await inputNumero.dispatchEvent('change', { bubbles: true }).catch(() => {});

      // 5. CONTINUAR NÚMERO
      const btnContNum = page.locator('button.fontBoldAMX:has-text("Continuar"), button.bg-\\[\\#7b1fa2\\]:has-text("Continuar"), button:has-text("Continuar")').first();
      await btnContNum.waitFor({ state: "visible", timeout: 20000 });
      await btnContNum.click({ force: true });

      // 6. FORMULARIO PAGO + 🔑 CLIC SEGURO EN CONTINUAR
      const inputTarjeta = page.locator('input#creditCardNumber, input[placeholder*="16 dígitos" i], input[placeholder="Número de tarjeta"]').first();
      await inputTarjeta.waitFor({ state: "visible", timeout: 25000 });

      const inNombre = page.locator('input#creditCardName, input[placeholder*="Nombre completo" i], input[placeholder="Nombre"]').first();
      const inMes = page.locator('input#month, input.exp[placeholder="MM"], input[placeholder="MM"]').first();
      const inAnio = page.locator('input#year, input.exp[placeholder="AA"], input[placeholder="AA"]').first();
      const inFecha = page.locator('input[name="cardExpiry"][placeholder="MM / AA"], input[placeholder*="MM / AA" i], input[placeholder*="MM/AA" i]').first();
      const inCVV = page.locator('input#cvv-input, input[placeholder="000"], input[placeholder="CVV"]').first();
      const chkTerminos = page.locator('input[type="checkbox"]#terms, input[type="checkbox"][name*="terms" i], label[for*="terms" i]').first();

      // LLENADO COMPLETO
      await inputTarjeta.fill(tarjeta.tarjeta, { force: true });
      if (await inNombre.isVisible().catch(() => false)) {
        await inNombre.fill(nombreAleatorio(), { force: true });
      }

      if (await inMes.isVisible().catch(() => false)) {
        await inMes.fill(tarjeta.mes, { force: true });
        if (await inAnio.isVisible().catch(() => false)) {
          await inAnio.fill(tarjeta.anio.slice(-2), { force: true });
        }
      } else if (await inFecha.isVisible().catch(() => false)) {
        await inFecha.fill(`${tarjeta.mes}/${tarjeta.anio.slice(-2)}`, { force: true });
      }

      if (await inCVV.isVisible().catch(() => false)) {
        await inCVV.fill(tarjeta.cvv, { force: true });
      }

      if (await chkTerminos.isVisible().catch(() => false)) {
        await chkTerminos.check({ force: true }).catch(() => chkTerminos.click({ force: true }));
      }

      // Forzar validación React de todos los inputs
      await page.evaluate(() => {
        document.querySelectorAll('input').forEach(input => {
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        });
      }).catch(() => {});

      // ⏳ ESPERA CLAVE: DEJA QUE LA PÁGINA ACTIVE EL BOTÓN
      await esperar(1000);
      const btnContPago = page.locator('button[type="submit"].bg-\\[\\#7b1fa2\\]:has-text("Continuar"), button.fontBoldAMX:has-text("Continuar"), button:has-text("Continuar"), button:has-text("Pagar")').last();

      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const b = btns.reverse().find(el => (el.innerText || '').includes('Continuar') || (el.innerText || '').includes('Pagar'));
        if (b) {
          b.removeAttribute('disabled');
          b.style.pointerEvents = 'auto';
        }
      }).catch(() => {});

      await btnContPago.waitFor({ state: "visible", timeout: 25000 });
      await btnContPago.scrollIntoViewIfNeeded().catch(() => {});

      // 🖱️ CLIC FORZADO Y SEGURO
      await btnContPago.click({ force: true });
      await esperar(1500);

      // 7. TARJETA FÍSICA (SI APARECE MODAL)
      const btnFisica = page.locator('button.ModalInvitation_buttonModal__42s7X, button:has-text("Continuar con mi tarjeta física")').first();
      if (await btnFisica.isVisible({ timeout: 5000 }).catch(() => false)) {
        await btnFisica.scrollIntoViewIfNeeded().catch(() => {});
        await btnFisica.click({ force: true }).catch(() => {});
      }

      // 8. RESULTADO
      await fsPromises.mkdir(CARPETA_TMP, { recursive: true }).catch(() => {});
      const rutaCaptura = path.join(CARPETA_TMP, `exito_${id}.png`);
      await esperar(3000);
      const captura = await page.screenshot({ fullPage: true, path: rutaCaptura }).catch(() => null);

      if (captura) {
        await ctx.replyWithPhoto({ source: captura }, {
          caption: `✅ RECARGA PROCESADA\n📦 Monto: $${monto}\n📱 Número: ${numero}\n💳 Tarjeta: ****${ultimos4(tarjeta.tarjeta)}`
        });
      } else {
        await ctx.reply(`✅ RECARGA PROCESADA\n📦 Monto: $${monto}\n📱 Número: ${numero}\n💳 Tarjeta: ****${ultimos4(tarjeta.tarjeta)}`);
      }
      return;

    } catch (error) {
      await ctx.reply(`⚠️ Intento ${intento} falló: ${error.message.slice(0, 150)}`);
      if (intento === INTENTOS_MAX) {
        await ctx.reply(`❌ FALLO TOTAL\n📌 Etapa: Proceso completo\n🔗 URL: ${page?.url() || "No disponible"}`);
      }
      await esperar(1500);
    } finally {
      await limpiarRecursos(id, browser, context, page);
    }
  }
}

// ==================================================
// 🤖 COMANDOS TELEGRAM (CON SELECCIÓN DE MONTO)
// ==================================================
bot.command('start', async ctx => {
  await ctx.reply('🤖 BOT TELCEL ACTIVO\n📌 /recarga - Iniciar recarga\n💰 Montos: 200 / 300 / 500');
});

bot.command('recarga', async ctx => {
  sesiones.set(ctx.chat.id, { estado: "esperando_datos" });
  await ctx.reply('📤 ENVÍA:\nFormato: NUMERO|TARJETA|MM|AA|CVV|MONTO\nEjemplo: 5512345678|4111111111111111|12|28|123|200');
});

bot.on('text', async ctx => {
  const id = ctx.chat.id;
  const texto = ctx.message.text.trim();
  if (!sesiones.has(id) || sesiones.get(id).estado !== "esperando_datos") return;

  const partes = texto.split('|');
  if (partes.length >= 5) {
    const [numero, tarjeta, mes, anio, cvv, monto] = partes.map(p => p.trim());
    const montoFinal = [200, 300, 500].includes(Number(monto)) ? Number(monto) : 200;
    sesiones.delete(id);
    await procesarRecarga(ctx, numero, { tarjeta, mes, anio, cvv }, montoFinal);
  } else {
    await ctx.reply('❌ FORMATO INCORRECTO\nUsa: NUMERO|TARJETA|MM|AA|CVV|MONTO');
  }
});

// ==================================================
// 🚀 SERVIDOR RENDER
// ==================================================
const servidor = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('✅ BOT ACTIVO');
});

servidor.listen(PUERTO, '0.0.0.0', () => console.log(`🌐 Puerto ${PUERTO}`));

bot.launch({ polling: true }).then(() => console.log('🤖 BOT TELEGRAM LISTO'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

