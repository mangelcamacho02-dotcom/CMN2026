/**
 * Prueba de punta a punta del frontend en un navegador (Playwright + Chromium),
 * con el Apps Script simulado (gas_mock.js) y los datos reales del Excel.
 * Uso:  NODE_PATH=$(npm root -g) node pruebas/test_ui.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
const { crearEntorno } = require('./gas_mock');

const RAIZ = path.join(__dirname, '..');
const API_FALSA = 'https://script.google.com/macros/s/PRUEBA/exec';
const CAPTURAS = path.join(__dirname, 'capturas');
fs.mkdirSync(CAPTURAS, { recursive: true });

// Servidor estático; app.js se sirve con la URL de prueba.
const servidor = http.createServer((req, res) => {
  const archivo = path.join(RAIZ, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!archivo.startsWith(RAIZ) || !fs.existsSync(archivo)) { res.writeHead(404); return res.end(); }
  let cuerpo = fs.readFileSync(archivo);
  if (archivo.endsWith('app.js')) cuerpo = cuerpo.toString().replace(/const API_URL = '[^']*'/, `const API_URL = '${API_FALSA}'`);
  const tipos = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  res.writeHead(200, { 'Content-Type': (tipos[path.extname(archivo)] || 'text/plain') + '; charset=utf-8' });
  res.end(cuerpo);
});

let pasadas = 0;
async function paso(nombre, fn) {
  try { await fn(); pasadas++; console.log('  ✔ ' + nombre); } catch (e) { console.log('  ✘ ' + nombre + '\n    ' + e.message); throw e; }
}

(async () => {
  await new Promise((r) => servidor.listen(0, r));
  const BASE = `http://localhost:${servidor.address().port}/`;

  const g = crearEntorno();
  const sal = g.hojas.Salones;
  sal.slice(1).forEach((f, i) => { f[1] = String(1000 + i); });
  const pin = (s) => sal.find((f) => f[0] === s)[1];
  g.hojas.Config.find((f) => f[0] === 'PIN_admin')[1] = '999999';
  g.hojas.Config.push(['Fecha_inicio', g.fecha('2026-11-09T06:00:00Z')]);
  g.fijarAhora('2026-11-10T17:00:00Z'); // martes 11:00 a.m.

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'es-CR', acceptDownloads: true });
  const page = await ctx.newPage();
  const erroresJs = [];
  page.on('pageerror', (e) => erroresJs.push(e.message));

  let redCaida = false;
  let peticiones = 0;
  await ctx.route(API_FALSA + '**', async (route) => {
    peticiones++;
    if (redCaida) return route.abort('internetdisconnected');
    const req = route.request();
    const cuerpo = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : null;
    const r = cuerpo ? g.post(cuerpo) : g.get(Object.fromEntries(new URL(req.url()).searchParams));
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(r) });
  });

  console.log('\nPrueba de interfaz (celular 390×844)');
  await page.goto(BASE);

  await paso('Inicio: título del evento y 10 tarjetas de salón con avance', async () => {
    await page.waitForSelector('.tarjeta-salon');
    assert.strictEqual(await page.textContent('#kicker'), 'Congreso Médico Nacional 2026');
    assert.strictEqual(await page.textContent('#tituloEvento'), 'Asistencia');
    assert.strictEqual(await page.locator('.tarjeta-salon').count(), 10);
    assert.match(await page.locator('.tarjeta-salon', { hasText: 'Roble 2' }).textContent(), /0 \/ 66 charlas registradas/);
    await page.screenshot({ path: path.join(CAPTURAS, '1_inicio.png'), fullPage: true });
  });

  await paso('Carrusel de salones: flechas, puntos y deslizar', async () => {
    const pista = page.locator('#gridSalones');
    assert.strictEqual(await page.locator('#carPuntos .car-punto').count(), 10);
    assert.ok(await page.locator('#carPrev').isDisabled(), 'al inicio la flecha izquierda debe estar desactivada');
    assert.strictEqual(await page.getAttribute('#carPuntos .car-punto >> nth=0', 'aria-current'), 'true');
    await page.click('#carNext');
    await page.waitForFunction(() => document.getElementById('gridSalones').scrollLeft > 50);
    await page.waitForTimeout(500);
    assert.strictEqual(await page.getAttribute('#carPuntos .car-punto >> nth=1', 'aria-current'), 'true');
    assert.ok(!(await page.locator('#carPrev').isDisabled()));
    await page.click('#carPuntos .car-punto >> nth=9');
    await page.waitForTimeout(700);
    assert.ok(await page.locator('#carNext').isDisabled(), 'al final la flecha derecha debe estar desactivada');
    const anchoPagina = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(anchoPagina <= 390, 'la página no debe desbordar a lo ancho: ' + anchoPagina);
    await page.screenshot({ path: path.join(CAPTURAS, '1b_carrusel_final.png') });
    await page.click('#carPuntos .car-punto >> nth=0');
    await page.waitForTimeout(700);
    assert.ok(await pista.evaluate((el) => el.scrollLeft < 5));
  });

  await paso('PIN de otro salón es rechazado en pantalla', async () => {
    await page.click('.tarjeta-salon:has-text("Roble 2")');
    await page.fill('#inpPin', pin('Real 1'));
    await page.click('#btnEntrar');
    await page.waitForSelector('#errorPin:not([hidden])');
    assert.match(await page.textContent('#errorPin'), /PIN incorrecto para Roble 2/);
    await page.screenshot({ path: path.join(CAPTURAS, '2_pin_rechazado.png') });
  });

  await paso('PIN correcto → abre el día de hoy (martes) con 4 simposios en orden', async () => {
    await page.fill('#inpPin', pin('Roble 2'));
    await page.click('#btnEntrar');
    await page.waitForSelector('.bloque');
    assert.strictEqual(await page.getAttribute('.tab-dia[aria-selected="true"]', 'data-dia'), 'Martes');
    const titulos = await page.locator('.bloque-cab h3').allTextContents();
    assert.deepStrictEqual(titulos, ['Cirugía 360',
      'Actualización Integral en Cirugía Moderna: Complicaciones, Innovación y Retos Quirúrgicos Actuales',
      'Daño Corporal 2026', 'Funcionar no es estar bien']);
    const rangos = await page.locator('.bloque-cab .rango').allTextContents();
    assert.deepStrictEqual(rangos, ['9:00 a.m. – 10:20 a.m.', '10:30 a.m. – 11:50 a.m.', '1:30 p.m. – 2:50 p.m.', '2:55 p.m. – 3:55 p.m.']);
    assert.strictEqual(await page.locator('.bloque').nth(0).locator('.charla').count(), 4);
    assert.match(await page.locator('.bloque-cab .entidad').first().textContent(), /Asociación Costarricense de Cirugía/);
    await page.screenshot({ path: path.join(CAPTURAS, '3_roble2_martes.png'), fullPage: true });
  });

  await paso('Guardar una charla → verde "Guardado 11:00 a.m. por Roble 2"', async () => {
    const c = page.locator('#c-ACT-0165');
    await c.locator('input').fill('42');
    assert.match(await c.locator('.estado').textContent(), /sin guardar/i);
    await c.locator('button').click();
    await page.waitForFunction(() => /Guardado/.test(document.querySelector('#c-ACT-0165 .estado').textContent));
    assert.strictEqual(await c.locator('.estado').textContent(), 'Guardado 11:00 a.m. por Roble 2');
    assert.match(await c.getAttribute('class'), /guardada/);
    assert.strictEqual(await page.textContent('#resTotal'), '42');
    assert.strictEqual(await page.textContent('#resCharlas'), '1 / 15');
  });

  await paso('Sin conexión: muestra error en rojo, conserva el número y permite reintentar', async () => {
    const c = page.locator('#c-ACT-0166');
    await c.locator('input').fill('37');
    redCaida = true;
    await c.locator('button').click();
    await page.waitForFunction(() => /Error/.test(document.querySelector('#c-ACT-0166 .estado').textContent));
    assert.match(await c.getAttribute('class'), /con-error/);
    assert.strictEqual(await c.locator('input').inputValue(), '37');
    await page.screenshot({ path: path.join(CAPTURAS, '4_error_red.png') });
    redCaida = false;
    await c.locator('button').click();
    await page.waitForFunction(() => /Guardado/.test(document.querySelector('#c-ACT-0166 .estado').textContent));
  });

  await paso('Actualización automática no borra lo que se está escribiendo', async () => {
    const c = page.locator('#c-ACT-0167');
    await c.locator('input').fill('15');
    // Otro usuario (admin) cambia la hoja mientras tanto.
    g.hojas.Actividades.find((f) => f[0] === 'ACT-0168')[12] = 99;
    await page.evaluate(() => refrescarSiToca(true));
    await page.waitForTimeout(300);
    assert.strictEqual(await c.locator('input').inputValue(), '15');
    await page.locator('#resTotal').click(); // sale del campo → se aplica la actualización pendiente
    await page.waitForFunction(() => document.querySelector('#c-ACT-0168 input').value === '99');
    assert.strictEqual(await page.locator('#c-ACT-0167 input').inputValue(), '15');
    assert.match(await page.locator('#c-ACT-0168 .estado').textContent(), /editado en la hoja/);
  });

  await paso('Guardar todo guarda los campos modificados', async () => {
    await page.locator('#c-ACT-0169 input').fill('20');
    assert.strictEqual(await page.textContent('#btnGuardarTodo'), 'Guardar todo (2)');
    await page.click('#btnGuardarTodo');
    await page.waitForFunction(() => /Guardado/.test(document.querySelector('#c-ACT-0169 .estado').textContent) &&
      /Guardado/.test(document.querySelector('#c-ACT-0167 .estado').textContent));
    assert.strictEqual(await page.textContent('#btnGuardarTodo'), 'Guardar todo');
  });

  await paso('Cambiar de día no pide PIN otra vez; charla PENDIENTE se ve con etiqueta naranja', async () => {
    await page.goto(BASE + '#/salon/Cedro%201');
    await page.fill('#inpPin', pin('Cedro 1'));
    await page.click('#btnEntrar');
    await page.waitForSelector('.bloque');
    await page.click('.tab-dia[data-dia="Lunes"]');
    const c = page.locator('#c-ACT-0005');
    await c.waitFor();
    assert.strictEqual(await c.locator('.etq-pendiente').textContent(), 'PENDIENTE — expositor por confirmar');
    assert.match(await c.locator('.expositores').textContent(), /Expositor por confirmar/);
    await c.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(CAPTURAS, '5_pendiente.png') });
    await c.locator('input').fill('8');
    await c.locator('button').click();
    await page.waitForFunction(() => /Guardado/.test(document.querySelector('#c-ACT-0005 .estado').textContent));
    await page.click('.tab-dia[data-dia="Martes"]');
    await page.goto(BASE + '#/salon/Roble%202/Martes');
    await page.waitForSelector('#c-ACT-0165');
    assert.ok(await page.locator('#vPin').isHidden(), 'volvió a pedir el PIN');
  });

  await paso('Días sin actividades aparecen deshabilitados (Laurel 1)', async () => {
    await page.goto(BASE + '#/salon/Laurel%201');
    await page.fill('#inpPin', pin('Laurel 1'));
    await page.click('#btnEntrar');
    await page.waitForSelector('.charla');
    const deshab = await page.locator('.tab-dia:disabled').count();
    assert.ok(deshab >= 1, 'debería haber días deshabilitados');
    console.log(`      Laurel 1: ${5 - deshab} día(s) con actividades, ${deshab} deshabilitado(s)`);
  });

  await paso('Panel de administrador: totales, atrasadas, corregir, bitácora, CSV', async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(BASE + '#/admin');
    await page.fill('#inpPin', pin('Roble 2'));
    await page.click('#btnEntrar');
    await page.waitForSelector('#errorPin:not([hidden])'); // PIN de salón no abre el panel
    await page.fill('#inpPin', '999999');
    await page.click('#btnEntrar');
    await page.waitForSelector('.kpi');
    assert.match(await page.locator('.kpi').first().textContent(), /^221/); // 42+37+15+99+20+8
    await page.screenshot({ path: path.join(CAPTURAS, '6_admin_totales.png'), fullPage: false });
    const nAtr = Number(await page.textContent('#nAtrasadas'));
    assert.ok(nAtr > 50, 'debería haber charlas atrasadas del lunes y martes: ' + nAtr);
    await page.click('[data-tab="atrasadas"]');
    await page.selectOption('#fSalon', 'Roble 2');
    await page.selectOption('#fDia', 'Martes');
    const idsAtr = await page.locator('#admAtrasadas tbody tr[id] td:first-child').allTextContents();
    assert.deepStrictEqual(idsAtr, [], 'Roble 2 martes ya tiene registradas las que pasaron: ' + idsAtr);
    await page.selectOption('#fSalon', 'Cedro 1');
    const idsCedro = await page.locator('#admAtrasadas tbody tr[id] td:first-child').allTextContents();
    assert.ok(idsCedro.length > 0);
    // Corregir desde admin
    await page.click('[data-tab="charlas"]');
    await page.selectOption('#fSalon', 'Roble 2');
    const fila = page.locator('#f-ACT-0165');
    await fila.locator('input').fill('45');
    await fila.locator('button').click();
    await page.waitForFunction(() => /Administrador/.test(document.querySelector('#f-ACT-0165 .celda-estado').textContent));
    await page.screenshot({ path: path.join(CAPTURAS, '7_admin_charlas.png') });
    // Bitácora
    await page.click('[data-tab="bitacora"]');
    await page.waitForSelector('#admBitacora tbody tr td');
    const primera = await page.locator('#admBitacora tbody tr').first().textContent();
    assert.match(primera, /Administrador.*ACT-0165.*42.*45/s);
    // CSV
    await page.click('[data-tab="charlas"]');
    const [descarga] = await Promise.all([page.waitForEvent('download'), page.click('#admCsv')]);
    const contenido = fs.readFileSync(await descarga.path(), 'utf8');
    assert.ok(contenido.startsWith('﻿ID,Dia,Salon'));
    assert.strictEqual(contenido.trim().split('\r\n').length, 1 + 15); // respeta filtros: Roble 2 + Martes
  });

  await paso('Bloquear edición desde el panel → el encargado solo puede ver', async () => {
    page.once('dialog', (d) => d.accept());
    await page.click('#admBloqueo');
    await page.waitForFunction(() => /BLOQUEADA/.test(document.querySelector('#admEstadoBloqueo').textContent));
    assert.strictEqual(g.hojas.Config.find((f) => f[0] === 'Bloquear_edicion')[1], 'SI');
    const p2 = await ctx.newPage(); // otra pestaña = otra sesión
    await p2.setViewportSize({ width: 390, height: 844 });
    await p2.goto(BASE + '#/salon/Real%201');
    await p2.fill('#inpPin', pin('Real 1'));
    await p2.click('#btnEntrar');
    await p2.waitForSelector('.charla');
    assert.ok(await p2.locator('#bloqueoSalon').isVisible());
    assert.ok(await p2.locator('.charla input').first().isDisabled());
    await p2.screenshot({ path: path.join(CAPTURAS, '8_bloqueado.png') });
    await p2.close();
  });

  assert.deepStrictEqual(erroresJs, [], 'errores de JavaScript: ' + erroresJs.join('; '));
  console.log(`\n${pasadas} pasos pasaron (${peticiones} peticiones a la API simulada). Capturas en pruebas/capturas/`);
  await browser.close();
  servidor.close();
})().catch(async (e) => { console.error(e); process.exit(1); });
