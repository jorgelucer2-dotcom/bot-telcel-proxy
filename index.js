'use strict';

require('dotenv').config();
const { Telegraf } = require('telegraf');
const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');

// ==================================================
// 🔑 CONFIGURACIÓN
// ==================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const PROXY = process.env.PROXY;
const URL_TELCEL = 'https://pay.telcel.com/package/1';
const PUERTO = process.env.PORT || 3000;

if (!BOT_TOKEN || !PROXY) {
  console.error("❌ FALTAN VARIABLES");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const sesionesActivas = new Map();
const CARPETA_TEMPORAL = path.join(__dirname, 'capturas_tmp');

// ==================================================
// ⚙️ FUNCIONES AUXILIARES
// ==================================================
function esperar(ms) { return new Promise(r=>setTimeout(r,ms)); }
function obtenerUltimos4(dato) { return typeof dato === 'string' ? dato.slice(-4) : '**'; }
function generarNombreCompletoAleatorio() {
  const n = ["Carlos","María","Juan","Ana","Luis","Sofía"];
  const a = ["García","Martínez","López","Pérez","Rodríguez"];
  return ${n[Math.floor(Math.random()*n.length)]} ${a[Math.floor(Math.random()*a.length)]};
}
async function inicializarCarpetaTmp() {
  try { await fs.access(CARPETA_TEMPORAL); }
  catch { await fs.mkdir(CARPETA_TEMPORAL, { recursive: true }); }
}

// ==================================================
// 🌐 NAVEGADOR
// ==================================================
async function crearInstanciaNavegador() {
  const navegador = await chromium.launch({
    proxy: PROXY,
    headless: true,
    timeout: 60000,
    args: ['--no-sandbox','--disable-dev-shm-usage','--start-maximized']
  });
  const contexto = await navegador.newContext({
    locale:"es-MX",
    geolocation:{latitude:19.4326,longitude:-99.1332},
    viewport:{width:1280,height:800}
  });
  return { navegador, contexto };
}

// ==================================================
// 🧹 LIMPIEZA
// ==================================================
async function limpiarRecursos(idChat, navegador, contexto, pagina) {
  try {
    if(pagina && !pagina.isClosed()) await pagina.close();
    if(contexto) await contexto.close();
    if(navegador) await navegador.close();
    sesionesActivas.delete(idChat);
  } catch {}
}

// ==================================================
// 📱 FLUJO PRINCIPAL (CORREGIDO PARA TU IMAGEN)
// ==================================================
async function ejecutarProcesoRecarga(ctx, numeroTelefono, datosTarjeta, montoSeleccionado = 200) {
  const idChat = ctx.chat.id;
  let navegadorActivo, contextoPagina, paginaActual;
  const INTENTOS_MAXIMOS = 3;

  for (let intento = 1; intento <= INTENTOS_MAXIMOS; intento++) {
    try {
      await inicializarCarpetaTmp();
      await ctx.reply(🔄 RECARGA $${montoSeleccionado} | Intento ${intento});

      ({ navegador: navegadorActivo, contexto: contextoPagina } = await crearInstanciaNavegador());
      paginaActual = await contextoPagina.newPage();

      // 1. ABRIR TELCEL
      await paginaActual.goto(URL_TELCEL, { waitUntil: "networkidle", timeout: 50000 });

      // 2. VER MÁS PAQUETES
      const btnVerMas = 'button:has-text("Ver más paquetes")';
      await paginaActual.waitForSelector(btnVerMas, { state: "visible", timeout: 20000 });
      await paginaActual.click(btnVerMas);

      // 3. SELECCIONAR MONTO (200/300/500)
      const selectorPaquete = div:has-text("$${montoSeleccionado}") + div button:has-text("Lo quiero");
      await paginaActual.waitForSelector(selectorPaquete, { state: "enabled", timeout: 25000 });
      await paginaActual.click(selectorPaquete);
      await paginaActual.waitForLoadState('networkidle');

      // 4. NÚMERO TELCEL
      await paginaActual.waitForSelector('input[aria-label="Número celular"]', { state: "editable", timeout: 25000 });
      const inputNumero = 'input[aria-label="Número celular"]';
      await paginaActual.fill(inputNumero, numeroTelefono);
      const btnContNum = 'button:has-text("Continuar"):not([disabled])';
      await paginaActual.waitForSelector(btnContNum, { state: "visible", timeout: 25000 });
      await paginaActual.click(btnContNum);

      // ✅ PASO CLAVE: FORMULARIO PAGO (TAL CUAL TU IMAGEN)
      await paginaActual.waitForSelector('input[placeholder="Número de tarjeta"]', { state: "editable", timeout: 35000 });

      // CAMPOS EXACTOS DE TU CAPTURA
      const inputTarjeta = 'input[placeholder="Número de tarjeta"]';
      const inputNombre = 'input[placeholder="Nombre completo"]'; // ✅ FIJADO
      const inputVencimiento = 'input[placeholder="Vencimiento"]';
      const inputCVV = 'input[placeholder="CVV"]';
      const btnContinuar = 'button:has-text("Continuar")';

      // LLENADO LENTO Y SEGURO
      await paginaActual.fill(inputTarjeta, datosTarjeta.tarjeta);
      await esperar(500);
      
      const nombreGenerado = generarNombreCompletoAleatorio();
      await paginaActual.fill(inputNombre, nombreGenerado); // ✅ ASEGURADO
      await esperar(500);
      
      await paginaActual.fill(inputVencimiento, ${datosTarjeta.mes}/${datosTarjeta.anio});
      await esperar(500);
      
      await paginaActual.fill(inputCVV, datosTarjeta.cvv);
      await esperar(1500); // Espera para que la página valide

      // ✅ ESPERA CRÍTICA: QUE BOTÓN SE HABILITE (NO MÁS GRIS)
      await paginaActual.waitForSelector(btnContinuar, { state: "enabled", timeout: 35000 });
      await paginaActual.waitForSelector(btnContinuar, { state: "visible" });
      
      // CLIC FORZADO Y SEGURO
      await paginaActual.click(btnContinuar, { force: true });
      await paginaActual.waitForLoadState('networkidle');

      // CAPTURA Y FINALIZACIÓN
      const captura = await paginaActual.screenshot({ fullPage: true });
      await ctx.replyWithPhoto({ source: captura }, {
        caption: ✅ RECARGA LISTA\n📦 $${montoSeleccionado}\n📱 ${numeroTelefono}\n👤 Nombre: ${nombreGenerado}\n💳 ****${obtenerUltimos4(datosTarjeta.tarjeta)}
      });
      return;

    } catch (err) {
      await ctx.reply(❌ FALLO: ${err.message.slice(0,180)});
      await limpiarRecursos(idChat, navegadorActivo, contextoPagina, paginaActual);
      await esperar(2000);
    }
  }
}

// ==================================================
// 🤖 COMANDOS TELEGRAM
// ==================================================
bot.command('start', async ctx => {
  await ctx.reply('🤖 BOT TELCEL ACTIVO\n📌 /recarga - Iniciar\n💰 Montos: 200/300/500');
});

bot.command('recarga', async ctx => {
  sesionesActivas.set(ctx.chat.id, { estado: "esperando_datos" });
  await ctx.reply('📤 FORMATO: NUMERO|TARJETA|MM|AA|CVV|MONTO\nEj: 5512345678|411111|12|28|123|200');
});

bot.on('text', async ctx => {
  const id = ctx.chat.id;
  const texto = ctx.message.text.trim();
  if (!sesionesActivas.has(id)) return;

  const partes = texto.split('|');
  if (partes.length >= 5) {
    const [num, cc, mes, anio, cvv, monto] = partes.map(p=>p.trim());
    const montoOk = [200,300,500].includes(Number(monto)) ? Number(monto) : 200;
    sesionesActivas.delete(id);
    await ejecutarProcesoRecarga(ctx, num, { tarjeta:cc, mes, anio, cvv }, montoOk);
  } else {
    await ctx.reply('❌ FORMATO MAL');
  }
});

// ==================================================
// 🚀 SERVIDOR RENDER
// ==================================================
const http = require('http');
const servidor = http.createServer((req,res)=>{
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('✅ BOT ACTIVO');
});

servidor.listen(PUERTO, '0.0.0.0', ()=>console.log(🌐 Puerto ${PUERTO}));

bot.launch({ polling:true }).then(()=>console.log('🤖 BOT LISTO'));

process.once('SIGINT', ()=>bot.stop('SIGINT'));
process.once('SIGTERM', ()=>bot.stop('SIGTERM'));
