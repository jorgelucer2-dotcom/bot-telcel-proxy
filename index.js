'use strict';

const http = require('http');
const https = require('https');
const { Telegraf, Markup } = require('telegraf');
const { chromium } = require('playwright');
require('dotenv').config();

// ==================================================
// 🔑 1. CONFIGURACIÓN Y VARIABLES DE ENTORNO
// ==================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const PUERTO = process.env.PORT || 3000;
const URL_TELCEL = process.env.URL_TELCEL || 'https://pay.telcel.com/package/1';
const BRIGHTDATA_BROWSER_WS = process.env.BRIGHTDATA_BROWSER_WS || process.env.PROXY || '';
const ES_HEADLESS = process.env.RENDER === 'true' || process.env.HEADLESS === 'true' || (process.platform === 'linux' && process.env.HEADLESS !== 'false');
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PUERTO}`;

if (!BOT_TOKEN) {
    console.error("❌ ERROR: La variable de entorno BOT_TOKEN no está configurada.");
}

const bot = new Telegraf(BOT_TOKEN || 'DUMMY_TOKEN', { handlerTimeout: Infinity });

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
const ultimoMensaje = new Map();

// ==================================================
// 🎲 2. GENERADORES Y UTILIDADES DE LIMPIEZA
// ==================================================
const NOMBRES = ['Carlos', 'Alejandro', 'Miguel', 'Jose', 'Juan', 'Fernando', 'Ricardo', 'Daniel', 'Eduardo', 'Gabriel', 'Sofia', 'Maria', 'Ana', 'Valeria', 'Camila', 'Andrea', 'Natalia', 'Daniela'];
const APELLIDOS = ['Hernandez', 'Garcia', 'Martinez', 'Lopez', 'Gonzalez', 'Perez', 'Rodriguez', 'Sanchez', 'Ramirez', 'Cruz', 'Flores', 'Gomez', 'Morales', 'Vazquez', 'Reyes', 'Jimenez'];

function generarNombreCompleto() {
    const nom = NOMBRES[Math.floor(Math.random() * NOMBRES.length)];
    const ape1 = APELLIDOS[Math.floor(Math.random() * APELLIDOS.length)];
    const ape2 = APELLIDOS[Math.floor(Math.random() * APELLIDOS.length)];
    return `${nom} ${ape1} ${ape2}`;
}

async function cerrarSesionNavegador(id) {
    if (navegadoresActivos.has(id)) {
        const nav = navegadoresActivos.get(id);
        try { await nav.close().catch(() => {}); } catch(e) {}
        navegadoresActivos.delete(id);
    }
    global.gc?.();
}

async function enviarLimpio(ctx, texto, opciones = {}) {
    const id = ctx.chat?.id || ctx.from?.id;
    if (!id) return ctx.reply(texto, opciones);

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

    const nuevoMsg = await ctx.reply(texto, opciones).catch(err => {
        console.error(`[Telegram Usuario ${id}] Error al enviar mensaje:`, err.message || err);
        return null;
    });

    if (nuevoMsg && nuevoMsg.message_id) {
        ultimoMensaje.set(id, nuevoMsg.message_id);
    }
    return nuevoMsg;
}

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
        console.error(`[Telegram Usuario ${id}] Error al enviar foto:`, err.message || err);
        return null;
    });

    if (nuevoMsg && nuevoMsg.message_id) {
        ultimoMensaje.set(id, nuevoMsg.message_id);
    }
    return nuevoMsg;
}

// ==================================================
// 🌐 3. NAVEGADOR Y GEOLOCALIZACIÓN MÉXICO
// ==================================================
async function lanzarNavegador(id) {
    await cerrarSesionNavegador(id);

    let navegador, contexto, pagina;
    const geoMexico = { latitude: 19.4326, longitude: -99.1332 };

    if (BRIGHTDATA_BROWSER_WS && (BRIGHTDATA_BROWSER_WS.startsWith('wss://') || BRIGHTDATA_BROWSER_WS.startsWith('ws://'))) {
        console.log(`[Usuario ${id}] 🌐 Conectando a Bright Data Browser...`);
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
        console.log(`[Usuario ${id}] 🖥️ Lanzando Chromium local...`);
        navegador = await chromium.launch({
            headless: ES_HEADLESS,
            timeout: 45000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--lang=es-MX'
            ]
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
                console.log(`[Telcel] 📍 Ubicación aceptada automáticamente (${s})`);
                return true;
            }
        } catch(e) {}
    }
    return false;
}

// ==================================================
// 📦 4. FUNCIONES MODULARES DE PAQUETES ($200, $300, $500)
// ==================================================
async function abrirMasPaquetes(pagina, monto) {
    await pagina.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

    const botonVerMas = pagina.locator('button:has(p:has-text("Ver más paquetes")), button:has-text("Ver más paquetes")');
    await botonVerMas.waitFor({ state: 'attached', timeout: 20000 });
    await botonVerMas.scrollIntoViewIfNeeded().catch(() => {});
    await botonVerMas.waitFor({ state: 'visible', timeout: 15000 });

    if (!(await botonVerMas.isEnabled().catch(() => false))) {
        throw new Error('BOTON_VER_MAS_PAQUETES_NO_HABILITADO');
    }

    await botonVerMas.click({ force: true });
    console.log('[Telcel] Clic en "Ver más paquetes" realizado');
    await pagina.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

    const regexCosto = new RegExp(`^\\$?\\s*${monto}$`, 'i');
    const tarjetaEsperada = pagina.locator('div.Plan_package__zO1Ss, div[class*="Plan_package__"]')
        .filter({ has: pagina.locator('b.Plan_b__DrgD_, [class*="Plan_b__"]').filter({ hasText: regexCosto }) })
        .filter({ has: pagina.locator('b.Plan_buttonPackageLabel__xB_jv, b:has-text("Lo quiero")') });

    await tarjetaEsperada.waitFor({ state: 'attached', timeout: 25000 });
    await tarjetaEsperada.waitFor({ state: 'visible', timeout: 25000 });
    console.log(`[Telcel] Tarjeta $${monto} confirmada y visible en el DOM`);
}

async function seleccionarPaquete(pagina, monto) {
    await pagina.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

    const regexCosto = new RegExp(`^\\$?\\s*${monto}$`, 'i');
    const tarjeta = pagina.locator('div.Plan_package__zO1Ss, div[class*="Plan_package__"]')
        .filter({ has: pagina.locator('b.Plan_b__DrgD_, [class*="Plan_b__"]').filter({ hasText: regexCosto }) })
        .filter({ has: pagina.locator('b.Plan_buttonPackageLabel__xB_jv, b:has-text("Lo quiero")') });

    await tarjeta.waitFor({ state: 'attached', timeout: 20000 });
    await tarjeta.waitFor({ state: 'visible', timeout: 20000 });

    const conteo = await tarjeta.count().catch(() => 0);
    if (conteo === 0) throw new Error(`PAQUETE_$${monto}_NO_ENCONTRADO`);
    if (conteo > 1) throw new Error(`MULTIPLES_PAQUETES_COINCIDENTES_$${monto}`);

    const botonLoQuiero = tarjeta.locator('b.Plan_buttonPackageLabel__xB_jv, b:has-text("Lo quiero"), button:has-text("Lo quiero")');
    await botonLoQuiero.scrollIntoViewIfNeeded().catch(() => {});
    await botonLoQuiero.waitFor({ state: 'visible', timeout: 15000 });

    if (!(await botonLoQuiero.isEnabled().catch(() => false))) {
        throw new Error(`BOTON_LO_QUIERO_$${monto}_NO_HABILITADO`);
    }

    await botonLoQuiero.click({ force: true });
    console.log(`[Telcel] Paquete $${monto} seleccionado`);
    await pagina.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
}

async function ejecutarConReintento(fn, intentosMax = 3, id) {
    let ultimoError = null;
    for (let intento = 1; intento <= intentosMax; intento++) {
        try {
            console.log(`[Usuario ${id}] 🔄 Ejecución intento ${intento}/${intentosMax}`);
            return await fn(intento);
        } catch (error) {
            ultimoError = error;
            console.error(`[Usuario ${id}] ⚠️ Error en intento ${intento}/${intentosMax}:`, error.message || error);
            if (intento < intentosMax) {
                await cerrarSesionNavegador(id);
            }
        }
    }
    throw ultimoError;
}

// ==================================================
// 💳 5. FLUJO AUTOMÁTICO DE RECARGA TELCEL
// ==================================================
async function flujoTelcelIndependiente(ctx, id, datos) {
    const { numero, cc, mes, anio, cvv, nombre, monto: montoIn } = datos;
    const monto = montoIn || 200;

    if (!numero || !/^\d{10}$/.test(numero)) {
        await cerrarSesionNavegador(id);
        return enviarLimpio(ctx, "❌ **Número celular inválido** (deben ser 10 dígitos).\n\nReintenta con: /recarga");
    }

    await enviarLimpio(
        ctx,
        `🔄 **PROCESANDO RECARGA TELCEL**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📱 **Número:** \`${numero}\`\n` +
        `💰 **Monto:** $${monto} MXN\n` +
        `💳 **Tarjeta:** \`****${cc.slice(-4)}\`\n\n` +
        `⏳ Conectando con Telcel Pay en segundo plano...`
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
                await pagina.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

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
                await pagina.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

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

                await pagina.waitForFunction((card) => {
                    const el = document.querySelector('input#creditCardNumber') || document.querySelector('input[placeholder*="16 dígitos" i]') || document.querySelector('input[name="cardNumber"]');
                    return el && el.value.replace(/\s+/g, '') === card;
                }, cc, { timeout: 10000 }).catch(() => {});

                const inputNom = pagina.locator('input#creditCardName, input[placeholder*="Nombre completo" i], input[name="cardHolderName"]').first();
                await inputNom.waitFor({ state: 'visible', timeout: 20000 });
                await inputNom.scrollIntoViewIfNeeded().catch(() => {});
                await inputNom.click({ force: true });
                await inputNom.fill(nombre, { force: true });
                await inputNom.dispatchEvent('input', { bubbles: true }).catch(() => {});
                await inputNom.dispatchEvent('change', { bubbles: true }).catch(() => {});
                await inputNom.dispatchEvent('blur', { bubbles: true }).catch(() => {});

                await pagina.waitForFunction((nom) => {
                    const el = document.querySelector('input#creditCardName') || document.querySelector('input[name="cardHolderName"]');
                    return el && el.value === nom;
                }, nombre, { timeout: 10000 }).catch(() => {});

                const inputMes = pagina.locator('input#month, input.exp[placeholder="MM"], input[placeholder="MM"]').first();
                const inputAnio = pagina.locator('input#year, input.exp[placeholder="AA"], input[placeholder="AA"]').first();
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
                        await inputAnio.fill(anio.slice(-2), { force: true });
                        await inputAnio.dispatchEvent('input', { bubbles: true }).catch(() => {});
                        await inputAnio.dispatchEvent('change', { bubbles: true }).catch(() => {});
                    }
                } else if (await inputFecha.isVisible({ timeout: 3000 }).catch(() => false)) {
                    await inputFecha.scrollIntoViewIfNeeded().catch(() => {});
                    await inputFecha.click({ force: true });
                    await inputFecha.fill(`${mes}/${anio.slice(-2)}`, { force: true });
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
                    console.log(`[Telcel] Clic en 'Continuar con mi tarjeta física' realizado`);
                }

                ultimaEtapa = "Esperando procesamiento de Telcel";
                await pagina.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

                const capturaProcesando = await pagina.screenshot({ fullPage: true }).catch(() => null);
                if (capturaProcesando && miId === ejecucionesUsuario.get(id)) {
                    await enviarFotoLimpia(
                        ctx,
                        { source: capturaProcesando },
                        {
                            caption:
                                `🔄 **PROCESANDO EN TELCEL PAY**\n` +
                                `━━━━━━━━━━━━━━━━━━\n` +
                                `📱 **Número:** \`${numero}\`\n` +
                                `💰 **Monto:** $${monto} MXN\n` +
                                `💳 **Tarjeta:** \`****${cc.slice(-4)}\`\n\n` +
                                `⏳ Esperando confirmación bancaria...`
                        }
                    );
                }

                ultimaEtapa = "Resultado de transacción";
                let tipoPantalla = "DESCONOCIDO";

                await pagina.waitForFunction(() => {
                    const texto = (document.body ? document.body.innerText : '') || '';
                    return /(pago\s*exitoso)|(transacci[óo]n\s*exitosa)|(recarga\s*exitosa)|(¡listo!)|(folio:)|(folio\s*\d+)|(comprobante)|(ticket)|(aprobada)|(gracias\s*por\s*tu\s*compra)|(tu\s*pago\s*ha\s*sido\s*(exitoso|procesado|aprobado))|(tu\s*recarga\s*fue\s*exitosa)|(bin\s*(inv[áa]lido|no\s*v[áa]lido|no\s*soportado))|(tarjeta\s*(inv[áa]lida|no\s*v[áa]lida|no\s*soportada|no\s*aceptada|no\s*reconocida))|(n[úu]mero\s*de\s*tarjeta\s*inv[áa]lido)|(emisor\s*no\s*soportado)|(tipo\s*de\s*tarjeta\s*no\s*v[áa]lida)|(revisa\s*el\s*n[úu]mero\s*de\s*tarjeta)|(tarjeta\s*no\s*permitida)|(tu\s*solicitud\s*no\s*pudo\s*ser\s*(completada|procesada))|(no\s*se\s*pudo\s*realizar\s*(el\s*pago|la\s*operaci[óo]n))|(transacci[óo]n\s*declinada)|(pago\s*rechazado)|(tarjeta\s*rechazada)|(fondos\s*insuficientes)|(error\s*al\s*procesar)|(intenta\s*con\s*otra\s*tarjeta)|(operaci[óo]n\s*no\s*exitosa)|(hubo\s*un\s*problema\s*al\s*procesar)|(no\s*autorizada)|(rechazada\s*por\s*el\s*banco)/i.test(texto);
                }, null, { timeout: 90000, polling: 500 }).catch(() => {});

                await pagina.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

                const textoPagina = await pagina.evaluate(() => {
                    return (document.body ? document.body.innerText : '') || '';
                }).catch(() => '');

                if (/(pago\s*exitoso)|(transacci[óo]n\s*exitosa)|(recarga\s*exitosa)|(¡listo!)|(folio:)|(folio\s*\d+)|(comprobante)|(ticket)|(aprobada)|(gracias\s*por\s*tu\s*compra)|(tu\s*pago\s*ha\s*sido\s*(exitoso|procesado|aprobado))|(tu\s*recarga\s*fue\s*exitosa)/i.test(textoPagina)) {
                    tipoPantalla = "PAGO_EXITOSO";
                } else if (/(bin\s*(inv[áa]lido|no\s*v[áa]lido|no\s*soportado))|(tarjeta\s*(inv[áa]lida|no\s*v[áa]lida|no\s*soportada|no\s*aceptada|no\s*reconocida))|(n[úu]mero\s*de\s*tarjeta\s*inv[áa]lido)|(emisor\s*no\s*soportado)|(tipo\s*de\s*tarjeta\s*no\s*v[áa]lida)|(revisa\s*el\s*n[úu]mero\s*de\s*tarjeta)|(tarjeta\s*no\s*permitida)/i.test(textoPagina)) {
                    tipoPantalla = "BIN_INVALIDO";
                } else if (/(tu\s*solicitud\s*no\s*pudo\s*ser\s*(completada|procesada))|(no\s*se\s*pudo\s*realizar\s*(el\s*pago|la\s*operaci[óo]n))|(transacci[óo]n\s*declinada)|(pago\s*rechazado)|(tarjeta\s*rechazada)|(fondos\s*insuficientes)|(error\s*al\s*procesar)|(intenta\s*con\s*otra\s*tarjeta)|(operaci[óo]n\s*no\s*exitosa)|(hubo\s*un\s*problema\s*al\s*procesar)|(no\s*autorizada)|(rechazada\s*por\s*el\s*banco)/i.test(textoPagina)) {
                    tipoPantalla = "SOLICITUD_NO_COMPLETADA";
                }

                const fechaHora = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });

                if (miId === ejecucionesUsuario.get(id)) {
                    if (tipoPantalla === "PAGO_EXITOSO") {
                        const capturaVoucher = await pagina.screenshot({ fullPage: true }).catch(() => null);
                        const captionVoucher = 
                            `✅ **RECARGA FINALIZADA CON ÉXITO** ✅\n` +
                            `━━━━━━━━━━━━━━━━━━\n` +
                            `📅 Fecha: ${fechaHora}\n` +
                            `💰 Monto: $${monto} MXN\n` +
                            `📱 Número: \`${numero}\`\n` +
                            `👤 Titular: ${nombre}\n` +
                            `💳 Tarjeta: ****${cc.slice(-4)}`;

                        if (capturaVoucher) {
                            await enviarFotoLimpia(
                                ctx,
                                { source: capturaVoucher },
                                {
                                    caption: captionVoucher.slice(0, 1024),
                                    ...Markup.inlineKeyboard([
                                        [Markup.button.callback('📱 Nueva Recarga', 'nueva_recarga_telcel')],
                                        [Markup.button.callback('❌ Salir', 'cancelar_accion')]
                                    ])
                                }
                            );
                            ultimoMensaje.delete(id);
                        } else {
                            await enviarLimpio(
                                ctx,
                                captionVoucher,
                                Markup.inlineKeyboard([
                                    [Markup.button.callback('📱 Nueva Recarga', 'nueva_recarga_telcel')],
                                    [Markup.button.callback('❌ Salir', 'cancelar_accion')]
                                ])
                            );
                            ultimoMensaje.delete(id);
                        }
                    } else {
                        let mensajeError = '';
                        if (tipoPantalla === "BIN_INVALIDO") {
                            mensajeError = 
                                `❌ **RECARGA NO COMPLETADA** ❌\n` +
                                `━━━━━━━━━━━━━━━━━━\n` +
                                `📅 Fecha: ${fechaHora}\n` +
                                `📍 Etapa: Procesamiento de pago\n` +
                                `💬 Motivo: BIN o tarjeta no admitida por Telcel\n` +
                                `📱 Número: \`${numero}\`\n` +
                                `💰 Monto: $${monto} MXN\n` +
                                `💳 Tarjeta: ****${cc.slice(-4)}\n\n` +
                                `🔄 Instrucción: Por favor intenta con otra tarjeta.`;
                        } else if (tipoPantalla === "SOLICITUD_NO_COMPLETADA") {
                            mensajeError = 
                                `❌ **RECARGA NO COMPLETADA** ❌\n` +
                                `━━━━━━━━━━━━━━━━━━\n` +
                                `📅 Fecha: ${fechaHora}\n` +
                                `📍 Etapa: Procesamiento de pago\n` +
                                `💬 Motivo: Telcel no pudo completar la solicitud de pago\n` +
                                `📱 Número: \`${numero}\`\n` +
                                `💰 Monto: $${monto} MXN\n` +
                                `💳 Tarjeta: ****${cc.slice(-4)}\n\n` +
                                `🔄 Instrucción: Por favor intenta con otra tarjeta.`;
                        } else {
                            mensajeError = 
                                `❌ **RECARGA NO COMPLETADA** ❌\n` +
                                `━━━━━━━━━━━━━━━━━━\n` +
                                `📅 Fecha: ${fechaHora}\n` +
                                `📍 Etapa: Procesamiento de pago\n` +
                                `💬 Motivo: Respuesta no concluyente de Telcel\n` +
                                `📱 Número: \`${numero}\`\n` +
                                `💰 Monto: $${monto} MXN\n` +
                                `💳 Tarjeta: ****${cc.slice(-4)}`;
                        }

                        const capturaError = await pagina.screenshot({ fullPage: true }).catch(() => null);

                        if (capturaError) {
                            await enviarFotoLimpia(
                                ctx,
                                { source: capturaError },
                                {
                                    caption: mensajeError.slice(0, 1024),
                                    ...Markup.inlineKeyboard([
                                        [Markup.button.callback('📱 Intentar de Nuevo', 'nueva_recarga_telcel')],
                                        [Markup.button.callback('❌ Salir', 'cancelar_accion')]
                                    ])
                                }
                            );
                        } else {
                            await enviarLimpio(
                                ctx,
                                mensajeError,
                                Markup.inlineKeyboard([
                                    [Markup.button.callback('📱 Intentar de Nuevo', 'nueva_recarga_telcel')],
                                    [Markup.button.callback('❌ Salir', 'cancelar_accion')]
                                ])
                            );
                        }
                    }
                }

                return true;

            } catch (errIntento) {
                ultimaEtapa = errIntento.message || ultimaEtapa;
                if (pagina && !pagina.isClosed()) {
                    ultimaCapturaError = await pagina.screenshot({ fullPage: true }).catch(() => null);
                }
                throw errIntento;
            } finally {
                await cerrarSesionNavegador(id);
            }
        }, 3, id);

    } catch (errTelcel) {
        console.error(`[Usuario ${id}] ❌ Fallo total tras reintentos:`, errTelcel.message || errTelcel);
        const fechaHora = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
        const mensajeErrorFinal = 
            `❌ **NO SE PUDO COMPLETAR LA RECARGA** ❌\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `📅 Fecha: ${fechaHora}\n` +
            `📍 Etapa: ${ultimaEtapa}\n` +
            `💬 Motivo: ${(errTelcel.message || 'Error en proceso').slice(0, 150)}\n` +
            `📱 Número: \`${numero}\`\n` +
            `💰 Monto: $${monto} MXN\n` +
            `💳 Tarjeta: ****${cc.slice(-4)}`;

        if (ultimaCapturaError) {
            await enviarFotoLimpia(
                ctx,
                { source: ultimaCapturaError },
                {
                    caption: mensajeErrorFinal.slice(0, 1024),
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('📱 Intentar de Nuevo', 'nueva_recarga_telcel')],
                        [Markup.button.callback('❌ Salir', 'cancelar_accion')]
                    ])
                }
            );
        } else {
            await enviarLimpio(
                ctx,
                mensajeErrorFinal,
                Markup.inlineKeyboard([
                    [Markup.button.callback('📱 Intentar de Nuevo', 'nueva_recarga_telcel')],
                    [Markup.button.callback('❌ Salir', 'cancelar_accion')]
                ])
            );
        }
    } finally {
        await cerrarSesionNavegador(id);
    }
}

// ==================================================
// 🤖 6. COMANDOS Y BOTONES TELEGRAM
// ==================================================
bot.command(['start', 'menu', 'ayuda'], async ctx => {
    const id = ctx.chat?.id || ctx.from?.id;
    await cerrarSesionNavegador(id);
    sesiones.set(id, { paso: 'elegir_monto' });

    await enviarLimpio(
        ctx,
        `🤖 **BOT DE RECARGAS TELCEL OFICIAL**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `⚡ Automatización rápida, segura y directa.\n\n` +
        `💰 **Selecciona el monto de tu recarga:**`,
        Markup.inlineKeyboard([
            [
                Markup.button.callback("💰 $200", "monto_200"),
                Markup.button.callback("💰 $300", "monto_300"),
                Markup.button.callback("💰 $500", "monto_500")
            ]
        ])
    );
});

bot.action(['monto_200', 'monto_300', 'monto_500'], async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    const id = ctx.chat?.id || ctx.from?.id;
    const monto = parseInt(ctx.match[0].replace('monto_', ''), 10) || 200;

    sesiones.set(id, { paso: 1, monto });

    await enviarLimpio(
        ctx,
        `💰 **RECARGA TELCEL $${monto} MXN**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📲 **PASO 1:** Escribe tu número celular a 10 dígitos:\n` +
        `Ejemplo: \`5512345678\``
    );
});

bot.action('nueva_recarga_telcel', async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    const id = ctx.chat?.id || ctx.from?.id;
    await cerrarSesionNavegador(id);
    sesiones.set(id, { paso: 'elegir_monto' });

    await enviarLimpio(
        ctx,
        `📱 **NUEVA RECARGA TELCEL**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Selecciona el monto que deseas recargar:`,
        Markup.inlineKeyboard([
            [
                Markup.button.callback("💰 $200", "monto_200"),
                Markup.button.callback("💰 $300", "monto_300"),
                Markup.button.callback("💰 $500", "monto_500")
            ]
        ])
    );
});

bot.action(['cancelar_accion', 'cancelar', 'salir'], async ctx => {
    await ctx.answerCbQuery().catch(() => {});
    const id = ctx.chat?.id || ctx.from?.id;
    await cerrarSesionNavegador(id);
    sesiones.delete(id);
    await enviarLimpio(ctx, "✅ Sesión cerrada y recursos liberados.\n📌 Escribe /start para reiniciar.");
});

bot.command(['recarga', 'telcel'], async ctx => {
    const id = ctx.chat?.id || ctx.from?.id;
    await cerrarSesionNavegador(id);

    const texto = ctx.message.text.trim();
    const args = texto.substring(texto.indexOf(' ') + 1).trim();

    const partesArgs = args.split(/\s+/);
    if (partesArgs.length >= 2 && /^\d{10}$/.test(partesArgs[0]) && partesArgs[1].includes('|')) {
        const numero = partesArgs[0];
        const partesTarjeta = partesArgs[1].split('|');
        let monto = 200;
        if (partesArgs[2] && [200, 300, 500].includes(parseInt(partesArgs[2], 10))) {
            monto = parseInt(partesArgs[2], 10);
        }
        if (partesTarjeta.length === 4) {
            const [cc, mes, anioCompleto, cvv] = partesTarjeta.map(d => d.trim());
            const anio = anioCompleto.slice(-2);
            const nombre = generarNombreCompleto();

            sesiones.set(id, { numero, cc, mes, anio, cvv, nombre, monto });

            return flujoTelcelIndependiente(ctx, id, { numero, cc, mes, anio, cvv, nombre, monto }).catch(err => {
                console.error(`[Telcel Usuario ${id}] Error:`, err.message || err);
            });
        }
    }

    sesiones.set(id, { paso: 'elegir_monto' });
    await enviarLimpio(
        ctx,
        `📱 **¿Cuánto deseas recargar?**\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Selecciona el monto:`,
        Markup.inlineKeyboard([
            [
                Markup.button.callback("💰 $200", "monto_200"),
                Markup.button.callback("💰 $300", "monto_300"),
                Markup.button.callback("💰 $500", "monto_500")
            ]
        ])
    );
});

bot.on('text', async (ctx, next) => {
    const id = ctx.chat?.id || ctx.from?.id;
    const txt = ctx.message.text.trim();

    if (txt.startsWith('/')) return next();

    if (!sesiones.has(id)) {
        sesiones.set(id, { paso: 'elegir_monto' });
        return enviarLimpio(
            ctx,
            `📱 **Bienvenido al Bot de Recargas Telcel**\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Selecciona el monto que deseas recargar:`,
            Markup.inlineKeyboard([
                [
                    Markup.button.callback("💰 $200", "monto_200"),
                    Markup.button.callback("💰 $300", "monto_300"),
                    Markup.button.callback("💰 $500", "monto_500")
                ]
            ])
        );
    }

    const estado = sesiones.get(id);
    const monto = estado.monto || 200;

    // PASO 1: RECIBIR NÚMERO
    if (estado.paso === 1 || estado.paso === 'numero') {
        if (!/^\d{10}$/.test(txt)) {
            return enviarLimpio(ctx, "❌ Número inválido (debe tener exactamente 10 dígitos).\n\n📲 Escribe tu número celular:");
        }
        sesiones.set(id, { paso: 2, numero: txt, monto });
        return enviarLimpio(
            ctx,
            `✅ **NÚMERO RECIBIDO:** \`${txt}\`\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💳 **PASO 2:** Envía los datos de tu tarjeta:\n` +
            `Formato: \`16DÍGITOS|MM|AAAA|CVV\`\n` +
            `Ejemplo: \`4111111111111111|08|2027|123\``
        );
    }

    // PASO 2: RECIBIR TARJETA Y LANZAR AUTOMÁTICAMENTE
    if (estado.paso === 2 || estado.paso === 'tarjeta') {
        const partes = txt.split('|').map(p => p.trim());
        if (partes.length !== 4) {
            return enviarLimpio(
                ctx,
                "❌ **Formato de tarjeta inválido.**\n\n" +
                "📌 Usa el formato: \`16DÍGITOS|MM|AAAA|CVV\`\n" +
                "Ejemplo: \`4111111111111111|08|2027|123\`\n\n" +
                "👉 Intenta de nuevo:"
            );
        }
        const [cc, mes, anioCompleto, cvv] = partes;
        if (!cc || !mes || !anioCompleto || !cvv) {
            return enviarLimpio(ctx, "❌ Faltan datos en la tarjeta.\n\n📌 Usa: \`16DÍGITOS|MM|AAAA|CVV\`");
        }

        const anio = (anioCompleto || '').slice(-2);
        const numero = estado.numero;
        const nombre = generarNombreCompleto();

        sesiones.set(id, { numero, cc, mes, anio, cvv, nombre, monto });

        flujoTelcelIndependiente(ctx, id, { numero, cc, mes, anio, cvv, nombre, monto }).catch(err => {
            console.error(`[Telcel Usuario ${id}] Error en ejecución:`, err.message || err);
        });
    }
});

// ==================================================
// 🚀 7. SERVIDOR HTTP Y MANTENEDOR ANTI-APAGADO
// ==================================================
const servidor = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot Telcel activo y funcionando ✅');
});

process.once('SIGINT', async () => {
    console.log("🔄 Cerrando bot limpiamente...");
    try { await bot.stop('SIGINT'); } catch(e) {}
    for (const [id] of navegadoresActivos) {
        await cerrarSesionNavegador(id);
    }
    servidor.close(() => process.exit(0));
});

process.once('SIGTERM', async () => {
    console.log("🔄 Terminando bot limpiamente...");
    try { await bot.stop('SIGTERM'); } catch(e) {}
    for (const [id] of navegadoresActivos) {
        await cerrarSesionNavegador(id);
    }
    servidor.close(() => process.exit(0));
});

servidor.listen(PUERTO, '0.0.0.0', () => {
    console.log(`✅ SERVIDOR LISTO EN PUERTO: ${PUERTO}`);
    console.log("⏳ Iniciando conexión Telegram...");

    // 🛡️ MANTENEDOR ANTI-APAGADO (RENDER KEEPALIVE CADA 10 MINUTOS)
    const INTERVALO_PING_MS = 10 * 60 * 1000;

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

    bot.launch({
        dropPendingUpdates: true,
        polling: true,
        timeout: 25000
    })
    .then(() => console.log("🤖 BOT TELEGRAM TELCEL CONECTADO EXITOSAMENTE"))
    .catch(err => console.error("❌ ERROR BOT:", err.message || err));
});
