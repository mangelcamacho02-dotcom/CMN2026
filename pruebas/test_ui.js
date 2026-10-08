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
  const ruta = decodeURIComponent(req.url.split('?')[0]);
  const archivo = path.join(RAIZ, ruta === '/' ? 'index.html' : ruta);
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
const col = (g, n) => g.hojas.Actividades[0].indexOf(n);
const fila = (g, id) => g.hojas.Actividades.find((f) => f[0] === id);

(async () => {
  await new Promise((r) => servidor.listen(0, r));
  const BASE = `http://localhost:${servidor.address().port}/`;

  const g = crearEntorno();
  g.hojas.Salones.slice(1).forEach((f, i) => { f[1] = String(1000 + i); });
  g.hojas.Config.find((f) => f[0] === 'PIN_admin')[1] = '999999';
  g.hojas.Config.push(['Fecha_inicio', g.fecha('2026-11-09T06:00:00Z')]);
  g.fijarAhora('2026-11-10T17:00:00Z'); // martes 11:00 a.m. Costa Rica

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-CR', acceptDownloads: true, timezoneId: 'America/Costa_Rica' });
  await ctx.addInitScript(() => {           // reloj del navegador = martes 11:00 a.m.
    const fijo = new Date('2026-11-10T17:00:00Z').getTime();
    const D = Date;
    // eslint-disable-next-line no-global-assign
    Date = class extends D { constructor(...a) { if (a.length) super(...a); else super(fijo); } static now() { return fijo; } };
  });
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
  const sinDesborde = async (p, ancho) => {
    const w = await p.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(w <= ancho, `la página desborda a lo ancho (${w} > ${ancho})`);
  };

  console.log('\nPrueba de interfaz (computadora 1440×900)');
  await page.goto(BASE);

  await paso('Abre sin PIN: 10 salones a la izquierda, hoy (martes) seleccionado', async () => {
    await page.waitForSelector('#listaSalones .salon');
    assert.strictEqual(await page.locator('#listaSalones .salon').count(), 10);
    assert.strictEqual(await page.getAttribute('.dia[aria-selected="true"]', 'data-dia'), 'Martes');
    assert.ok(await page.locator('#vPin').isHidden(), 'no debe pedir PIN');
    assert.match(await page.textContent('.salon[data-salon="Laurel 1"]'), /Sin charlas/);
    await sinDesborde(page, 1440);
  });

  await paso('Roble 2, martes: 4 simposios en orden con sus horarios', async () => {
    await page.fill('#inpNombre', 'Ana Mora');
    await page.click('.salon[data-salon="Roble 2"]');
    assert.strictEqual(await page.textContent('#cabSalon'), 'Roble 2');
    const titulos = await page.locator('.bloque-cab h3').allTextContents();
    assert.deepStrictEqual(titulos, ['Cirugía 360',
      'Actualización Integral en Cirugía Moderna: Complicaciones, Innovación y Retos Quirúrgicos Actuales',
      'Daño Corporal 2026', 'Funcionar no es estar bien']);
    assert.deepStrictEqual(await page.locator('.bloque-cab .rango').allTextContents(),
      ['9:00 a.m. – 10:20 a.m.', '10:30 a.m. – 11:50 a.m.', '1:30 p.m. – 2:50 p.m.', '2:55 p.m. – 3:55 p.m.']);
    assert.strictEqual(await page.locator('.fila').count(), 15);
    // 11:00 a.m.: la charla de 10:50–11:10 está en curso; las de antes ya terminaron.
    assert.match(await page.textContent('#c-ACT-0170 .c-hora'), /En curso/);
    assert.match(await page.textContent('#c-ACT-0165 .c-hora'), /Ya terminó/);
    assert.strictEqual(await page.evaluate(() => document.activeElement.dataset.id), 'ACT-0165', 'el cursor queda en la primera vacía');
  });

  await paso('Escribir + Enter guarda y pasa a la siguiente; queda quién registró', async () => {
    await page.keyboard.type('42');
    assert.match(await page.textContent('#c-ACT-0165 .estado'), /Sin guardar/);
    await page.keyboard.press('Enter');
    assert.strictEqual(await page.evaluate(() => document.activeElement.dataset.id), 'ACT-0166');
    await page.waitForFunction(() => /✓/.test(document.querySelector('#c-ACT-0165 .estado').textContent));
    assert.strictEqual(await page.textContent('#c-ACT-0165 .estado'), '✓ 11:00 a.m. · Ana Mora');
    assert.strictEqual(fila(g, 'ACT-0165')[col(g, 'Asistentes')], 42);
    assert.strictEqual(fila(g, 'ACT-0165')[col(g, 'Registrado_por')], 'Ana Mora');
    assert.strictEqual(await page.textContent('#resTotal'), '42');
    assert.strictEqual(await page.textContent('#resCharlas'), '1 / 15');
    assert.match(await page.textContent('.salon[data-salon="Roble 2"] .s-cuenta'), /^1\/15/);
  });

  await paso('Sin conexión: fila en rojo, conserva el número; Enter de nuevo reintenta', async () => {
    redCaida = true;
    await page.keyboard.type('37');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#c-ACT-0166').classList.contains('con-error'));
    assert.strictEqual(await page.inputValue('#c-ACT-0166 input'), '37');
    assert.ok(await page.locator('#c-ACT-0166 .btn-mini').isVisible(), 'debe mostrarse el botón Guardar para reintentar');
    redCaida = false;
    await page.click('#c-ACT-0166 .btn-mini');
    await page.waitForFunction(() => /✓/.test(document.querySelector('#c-ACT-0166 .estado').textContent));
  });

  await paso('Actualización automática no borra lo que se está escribiendo', async () => {
    await page.click('#c-ACT-0167 input');
    await page.keyboard.type('15');
    fila(g, 'ACT-0168')[col(g, 'Asistentes')] = 99; // alguien lo cambió en la hoja
    await page.evaluate(() => refrescarSiToca(true));
    await page.waitForFunction(() => document.querySelector('#c-ACT-0168 input').value === '99');
    assert.strictEqual(await page.inputValue('#c-ACT-0167 input'), '15');
    assert.strictEqual(await page.evaluate(() => document.activeElement.dataset.id), 'ACT-0167', 'no debe perder el cursor');
  });

  await paso('Cambios en varios salones + Ctrl+S guarda todo; charla PENDIENTE con etiqueta', async () => {
    await page.click('.dia[data-dia="Lunes"]');
    await page.click('.salon[data-salon="Cedro 1"]');
    const c = page.locator('#c-ACT-0005');
    assert.match(await c.textContent(), /PENDIENTE — expositor por confirmar/);
    assert.match(await c.textContent(), /Expositor por confirmar/);
    await c.locator('input').fill('8');
    assert.match(await page.textContent('#dockSum'), /2 cambios sin guardar en 2 salones/);
    assert.match(await page.textContent('.salon[data-salon="Cedro 1"]'), /1 sin guardar/);
    await page.screenshot({ path: path.join(CAPTURAS, '2_cedro1_lunes.png') });
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => /Todo guardado/.test(document.getElementById('dockSum').textContent));
    assert.strictEqual(fila(g, 'ACT-0005')[col(g, 'Asistentes')], 8);
    assert.strictEqual(fila(g, 'ACT-0167')[col(g, 'Asistentes')], 15);
    await page.click('.dia[data-dia="Martes"]');
    await page.click('.salon[data-salon="Roble 2"]');
    await page.locator('#tabla').click({ position: { x: 5, y: 5 } });
    await page.screenshot({ path: path.join(CAPTURAS, '1_registro_roble2.png') });
  });

  await paso('Buscar filtra salones por nombre o por charla', async () => {
    await page.fill('#buscar', 'robótica');
    await page.waitForTimeout(250);
    assert.deepStrictEqual(await page.locator('#listaSalones .salon .s-nombre').allTextContents(), ['Roble 2']);
    await page.fill('#buscar', '');
    await page.waitForTimeout(250);
    assert.strictEqual(await page.locator('#listaSalones .salon').count(), 10);
  });

  await paso('Administración pide PIN de admin: totales, corrección, bitácora, CSV', async () => {
    await page.click('#btnAdmin');
    await page.fill('#inpPin', '1000');               // un PIN de salón no sirve
    await page.click('#btnEntrar');
    await page.waitForSelector('#errorPin:not([hidden])');
    await page.fill('#inpPin', '999999');
    await page.click('#btnEntrar');
    await page.waitForSelector('.kpi');
    assert.match(await page.locator('.kpi').first().textContent(), /^201/); // 42 + 37 + 15 + 99 + 8
    await page.click('[data-tab="charlas"]');
    await page.selectOption('#fSalon', 'Roble 2');
    await page.selectOption('#fDia', 'Martes');
    const f = page.locator('#f-ACT-0165');
    await f.locator('input').fill('45');
    await f.locator('button').click();
    await page.waitForFunction(() => /Administrador/.test(document.querySelector('#f-ACT-0165 .celda-estado').textContent));
    await page.click('[data-tab="bitacora"]');
    await page.waitForSelector('#admBitacora tbody tr td');
    assert.match(await page.locator('#admBitacora tbody tr').first().textContent(), /Administrador.*ACT-0165.*42.*45/s);
    await page.click('[data-tab="charlas"]');
    const [descarga] = await Promise.all([page.waitForEvent('download'), page.click('#admCsv')]);
    const contenido = fs.readFileSync(await descarga.path(), 'utf8');
    assert.ok(contenido.startsWith('﻿ID,Dia,Salon'));
    assert.strictEqual(contenido.trim().split('\r\n').length, 1 + 15);
    await page.screenshot({ path: path.join(CAPTURAS, '3_admin.png') });
  });

  await paso('Bloquear edición → en el registro solo se puede consultar', async () => {
    page.once('dialog', (d) => d.accept());
    await page.click('#admBloqueo');
    await page.waitForFunction(() => /BLOQUEADA/.test(document.querySelector('#admEstadoBloqueo').textContent));
    await page.click('#btnVolver');
    await page.waitForSelector('#vRegistro:not([hidden])');
    await page.waitForFunction(() => !document.getElementById('avisoBloqueo').hidden);
    assert.ok(await page.locator('#tabla input').first().isDisabled());
    page.once('dialog', (d) => d.accept());
    await page.click('#btnAdmin');
    await page.waitForSelector('#admBloqueo');
    await page.click('#admBloqueo');
    await page.waitForFunction(() => /abierta/.test(document.querySelector('#admEstadoBloqueo').textContent));
    await page.click('#btnVolver');
  });

  await paso('En celular (390 px) se adapta sin desbordar', async () => {
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Costa_Rica' });
    await m.route(API_FALSA + '**', async (route) => route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(g.post(JSON.parse(route.request().postData() || '{}'))) }));
    const p = await m.newPage();
    await p.goto(BASE + '#/s/Roble%202/Martes');
    await p.waitForSelector('.fila');
    await sinDesborde(p, 390);
    await p.screenshot({ path: path.join(CAPTURAS, '4_celular.png') });
    await m.close();
  });

  assert.deepStrictEqual(erroresJs, [], 'errores de JavaScript: ' + erroresJs.join('; '));
  console.log(`\n${pasadas} pasos pasaron (${peticiones} peticiones a la API simulada). Capturas en pruebas/capturas/`);
  await browser.close();
  servidor.close();
})().catch(async (e) => { console.error(e); process.exit(1); });
