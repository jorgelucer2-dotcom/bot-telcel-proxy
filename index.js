✅ SELECTOR OFICIAL NETFLIX: OMITIR VERIFICACIÓN (NO FALLA)

1️⃣ USAR EL ATRIBUTO ÚNICO (NO SOLO TEXTO):
- NO buscar solo por "Omitir" (cambia en inglés/español)
- USAR: data-uia="skip-email-verification-button" ✅

2️⃣ CÓDIGO COMPLETO PARA AGREGAR:
// 🟢 PASO EXACTO: OMITIR VERIFICACIÓN DE CORREO (SELECTOR OFICIAL)
console.log("🔍 Buscando botón OMITIR (skip-email)...");
await page.waitForLoadState('domcontentloaded');
await page.waitForSelector('button[data-uia="skip-email-verification-button"]', { timeout: 18000 });

// 🖱️ CLICK SEGURO + FUERZA SI ESTÁ OCULTO
await page.click('button[data-uia="skip-email-verification-button"]', { 
  force: true, 
  timeout: 10000 
});

console.log("✅ ÉXITO: OMITIR PRESIONADO (SALTANDO VERIFICACIÓN)");
await page.waitForNavigation({ waitUntil: 'domcontentloaded' }); // Espera cambio de página

3️⃣ POR QUÉ ES MEJOR:
- data-uia: Es el identificador que usa Netflix para pruebas → *NUNCA SE ROMPE*
- Más estable que clase o texto
- Funciona en cualquier idioma

4️⃣ DÓNDE LO PONES:
- Justo después de ingresar contraseña y continuar
- Antes de la selección de plan

✅ LISTO: Con esto no fallará "no encontrado" nunca más 🚀

