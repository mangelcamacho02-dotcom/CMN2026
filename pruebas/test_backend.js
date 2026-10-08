/**
 * Pruebas de la lógica de Code.gs con los datos reales del Excel.
 * Uso:  python3 pruebas/xlsx_a_json.py BD_Asistencia_CMN2026.xlsx pruebas/datos_prueba.json
 *       node pruebas/test_backend.js
 */
'use strict';
const assert = require('assert');
const { crearEntorno } = require('./gas_mock');

let pasadas = 0;
const fallos = [];
function prueba(nombre, fn) {
  try { fn(); pasadas++; console.log('  ✔ ' + nombre); } catch (e) { fallos.push(nombre); console.log('  ✘ ' + nombre + '\n      ' + e.message); }
}

// PINes de prueba (en el Excel real todos dicen "CAMBIAR").
const PINES = { 'Real 1': '1111', 'Real 2': '2222', 'Real 3': '3333', 'Cedro 1': '4444', 'Cedro 2': '5555',
  'Cedro 3': '6666', 'Roble 1': '7777', 'Roble 2': '8888', 'Jacarandas 1-2': '9191', 'Laurel 1': '0123' };
const PIN_ADMIN = '240683';

function entornoConPines(extra) {
  const g = crearEntorno(extra);
  const sal = g.hojas.Salones; const h = sal[0];
  const cS = h.indexOf('Salon'); const cP = h.indexOf('PIN_encargado');
  sal.slice(1).forEach((f) => { f[cP] = PINES[f[cS]]; });
  sal[sal.findIndex((f) => f[cS] === 'Laurel 1')][cP] = 123; // Sheets convierte "0123" en número 123
  g.hojas.Config.find((f) => f[0] === 'PIN_admin')[1] = PIN_ADMIN;
  return g;
}
function tokenDe(g, salon, pin) {
  const r = g.post({ accion: 'login', salon, pin });
  assert.ok(r.ok, 'login falló: ' + r.error);
  return r.token;
}
const plano = (o) => JSON.parse(JSON.stringify(o)); // objetos creados dentro del simulador
const col = (g, hoja, nombre) => g.hojas[hoja][0].indexOf(nombre);
const filaAct = (g, id) => g.hojas.Actividades.find((f) => f[col(g, 'Actividades', 'ID')] === id);

console.log('\n1) Datos originales del Excel');
prueba('Con los PINes "CAMBIAR" del Excel nadie puede entrar (ni admin)', () => {
  const g = crearEntorno();
  const r1 = g.post({ accion: 'login', salon: 'Roble 2', pin: 'CAMBIAR' });
  assert.strictEqual(r1.ok, false); assert.match(r1.error, /no tiene PIN configurado/);
  const r2 = g.post({ accion: 'login', salon: '', pin: 'CAMBIAR' });
  assert.strictEqual(r2.ok, false);
});
prueba('getSalones: 10 salones activos, 527 charlas, sin PINes en la respuesta', () => {
  const g = entornoConPines();
  const r = g.post({ accion: 'getSalones' });
  assert.ok(r.ok);
  assert.strictEqual(r.evento, 'Congreso Médico Nacional 2026');
  assert.deepStrictEqual(r.dias, ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes']);
  assert.strictEqual(r.salones.length, 10);
  assert.strictEqual(r.salones.reduce((s, x) => s + x.total, 0), 527);
  const txt = JSON.stringify(r);
  Object.values(PINES).concat([PIN_ADMIN]).forEach((p) => assert.ok(!txt.includes('"' + p + '"'), 'aparece PIN ' + p));
  assert.ok(!/pin/i.test(txt), 'la respuesta menciona PINes');
});
prueba('getSalones también responde por GET; login por GET se rechaza', () => {
  const g = entornoConPines();
  assert.ok(g.get({ accion: 'getSalones' }).ok);
  assert.strictEqual(g.get({ accion: 'login', salon: 'Real 1', pin: '1111' }).ok, false);
});
prueba('Las 52 variantes de "Hora" del Excel se interpretan (inicio < fin)', () => {
  const g = entornoConPines();
  const horas = [...new Set(g.hojas.Actividades.slice(1).map((f) => f[col(g, 'Actividades', 'Hora')]))];
  assert.strictEqual(horas.length, 52);
  horas.forEach((h) => {
    const r = g.ctx.parsearHora_(h);
    assert.ok(r.inicio !== null && r.fin !== null && r.inicio < r.fin, 'no se entiende: ' + h + ' → ' + JSON.stringify(r));
    assert.ok(r.inicio >= 7 * 60 && r.fin <= 18 * 60, 'fuera del horario: ' + h);
  });
  const casos = { '9:00 - 12:00 p.m.': [540, 720], '1:30 p.m. - 2:20 p.m': [810, 860], '10:10 a.m. – 10:40 a.m.': [610, 640],
    '3:30 -- 3:50 p.m.': [930, 950], '9:00 - 9:20 am': [540, 560], '11:30 - 11:50 a.m.': [690, 710], '1:40 – 1:55  p.m.': [820, 835] };
  Object.entries(casos).forEach(([h, [i, f]]) => assert.deepStrictEqual(plano(g.ctx.parsearHora_(h)), { inicio: i, fin: f }, h));
});

console.log('\n2) Acceso con PIN');
prueba('PIN de otro salón es rechazado (Real 1 intenta entrar a Roble 2)', () => {
  const g = entornoConPines();
  const r = g.post({ accion: 'login', salon: 'Roble 2', pin: PINES['Real 1'] });
  assert.strictEqual(r.ok, false); assert.match(r.error, /PIN incorrecto para Roble 2/);
  assert.ok(!r.token);
});
prueba('PIN correcto entra como encargado; PIN admin entra a cualquier salón', () => {
  const g = entornoConPines();
  const r = g.post({ accion: 'login', salon: 'roble 2 ', pin: '8888' });
  assert.ok(r.ok); assert.strictEqual(r.rol, 'encargado'); assert.strictEqual(r.salon, 'Roble 2');
  const a = g.post({ accion: 'login', salon: 'Cedro 3', pin: PIN_ADMIN });
  assert.ok(a.ok); assert.strictEqual(a.rol, 'admin');
  const b = g.post({ accion: 'login', salon: '', pin: PIN_ADMIN });
  assert.ok(b.ok); assert.strictEqual(b.rol, 'admin');
  const c = g.post({ accion: 'login', salon: '', pin: '8888' });
  assert.strictEqual(c.ok, false, 'un PIN de salón no debe abrir el panel de admin');
});
prueba('PIN con cero inicial funciona aunque Sheets lo haya guardado como número (0123 → 123)', () => {
  const g = entornoConPines();
  assert.ok(g.post({ accion: 'login', salon: 'Laurel 1', pin: '0123' }).ok);
});
prueba('Token de un salón no sirve para leer otro salón', () => {
  const g = entornoConPines();
  const t = tokenDe(g, 'Real 1', '1111');
  const r = g.post({ accion: 'getActividades', salon: 'Roble 2', token: t });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.codigo, 'SESION');
});
prueba('Token alterado (cambiar el salón dentro del token) es rechazado', () => {
  const g = entornoConPines();
  const t = tokenDe(g, 'Real 1', '1111').replace(/^Real%201/, 'Roble%202');
  const r = g.post({ accion: 'getActividades', salon: 'Roble 2', token: t });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.codigo, 'SESION');
});
prueba('Si el admin cambia el PIN en la hoja, la sesión anterior deja de servir', () => {
  const g = entornoConPines();
  const t = tokenDe(g, 'Real 2', '2222');
  assert.ok(g.post({ accion: 'getActividades', salon: 'Real 2', token: t }).ok);
  g.hojas.Salones.find((f) => f[0] === 'Real 2')[1] = '4321';
  const r = g.post({ accion: 'getActividades', salon: 'Real 2', token: t });
  assert.strictEqual(r.ok, false); assert.match(r.error, /PIN cambió/);
});
prueba('Tras 15 PINes malos se bloquea el login 5 min, pero las sesiones abiertas siguen funcionando', () => {
  const g = entornoConPines();
  const t = tokenDe(g, 'Real 3', '3333');
  for (let i = 0; i < 15; i++) g.post({ accion: 'login', salon: 'Real 3', pin: '0000' });
  const r = g.post({ accion: 'login', salon: 'Real 3', pin: '3333' });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.codigo, 'PIN_BLOQUEADO');
  const idReal3 = g.hojas.Actividades.find((f) => f[col(g, 'Actividades', 'Salon')] === 'Real 3')[0];
  assert.ok(g.post({ accion: 'guardarAsistencia', id: idReal3, valor: 5, token: t }).ok);
  assert.ok(g.post({ accion: 'getActividades', salon: 'Real 3', token: t }).ok);
});
prueba('Salón desactivado (Activo = FALSE) no aparece y no deja entrar', () => {
  const g = entornoConPines();
  g.hojas.Salones.find((f) => f[0] === 'Laurel 1')[3] = false;
  assert.ok(!g.post({ accion: 'getSalones' }).salones.some((s) => s.salon === 'Laurel 1'));
  assert.strictEqual(g.post({ accion: 'login', salon: 'Laurel 1', pin: '0123' }).ok, false);
});

console.log('\n3) Actividades');
prueba('Roble 2, martes: 4 simposios en orden, con sus charlas', () => {
  const g = entornoConPines();
  const t = tokenDe(g, 'Roble 2', '8888');
  const r = g.post({ accion: 'getActividades', salon: 'Roble 2', dia: 'Martes', token: t });
  assert.ok(r.ok, r.error);
  const bloques = [];
  r.actividades.forEach((a) => {
    const k = a.simposio + '|' + a.entidad;
    if (!bloques.length || bloques[bloques.length - 1].k !== k) bloques.push({ k, n: 0, ini: a.inicio });
    bloques[bloques.length - 1].n++;
  });
  assert.deepStrictEqual(bloques.map((b) => b.k.split('|')[0]), [
    'Cirugía 360',
    'Actualización Integral en Cirugía Moderna: Complicaciones, Innovación y Retos Quirúrgicos Actuales',
    'Daño Corporal 2026',
    'Funcionar no es estar bien']);
  assert.deepStrictEqual(bloques.map((b) => b.n), [4, 4, 4, 3]);
  const inicios = r.actividades.map((a) => a.inicio);
  assert.deepStrictEqual(inicios, inicios.slice().sort((a, b) => a - b), 'no están en orden de hora');
  assert.deepStrictEqual(r.dias.filter((d) => d.activo).map((d) => d.dia), ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes']);
  console.log('      ' + bloques.map((b) => `${b.k.split('|')[0].slice(0, 30)} (${b.n})`).join(' → '));
});
prueba('Charla PENDIENTE: se envía con estado PENDIENTE y permite registrar asistencia', () => {
  const g = entornoConPines();
  const t = tokenDe(g, 'Cedro 1', '4444');
  const r = g.post({ accion: 'getActividades', salon: 'Cedro 1', dia: 'Lunes', token: t });
  const a = r.actividades.find((x) => x.id === 'ACT-0005');
  assert.strictEqual(a.estado, 'PENDIENTE');
  assert.strictEqual(a.charla, 'Pendiente');
  const s = g.post({ accion: 'guardarAsistencia', id: 'ACT-0005', valor: '12', token: t });
  assert.ok(s.ok, s.error); assert.strictEqual(s.actividad.asistentes, 12);
});
prueba('Varios expositores: se emparejan código y correo solo si las listas coinciden', () => {
  const g = entornoConPines();
  const t = tokenDe(g, '', PIN_ADMIN);
  const r = g.post({ accion: 'getResumenAdmin', token: t });
  const x = (id) => r.actividades.find((a) => a.id === id).expositores;
  const e67 = x('ACT-0067');
  assert.deepStrictEqual(e67.personas.map((p) => [p.codigo, p.correo]), [['6905', 'rosasur@gmail.com'], ['10130', 'jvillalta@ccss.sa.cr']]);
  const e68 = x('ACT-0068'); // 2 expositores, 1 correo (que es del segundo): no se adivina
  assert.deepStrictEqual(e68.personas.map((p) => p.correo), ['', '']);
  assert.deepStrictEqual(e68.correosSueltos, ['jvillalta@ccss.sa.cr']);
  assert.strictEqual(x('ACT-0465').personas.length, 3);
});

console.log('\n4) Guardado');
prueba('Guardar escribe solo Asistentes / Registrado_por / Fecha_registro y agrega Bitácora', () => {
  const g = entornoConPines();
  g.fijarAhora('2026-11-10T16:42:00Z'); // 10:42 a.m. en Costa Rica
  const antes = JSON.parse(JSON.stringify(g.hojas.Actividades));
  const t = tokenDe(g, 'Roble 2', '8888');
  const r = g.post({ accion: 'guardarAsistencia', id: 'ACT-0165', valor: '42', token: t });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.actividad.horaRegistro, '10:42 a.m.');
  assert.strictEqual(r.actividad.registradoPor, 'Roble 2');
  const permitidas = ['Asistentes', 'Registrado_por', 'Fecha_registro'].map((c) => col(g, 'Actividades', c));
  const despues = g.hojas.Actividades;
  let cambios = 0;
  despues.forEach((f, i) => f.forEach((v, j) => {
    const a = antes[i][j]; const b = v instanceof Date ? v.toISOString() : v;
    if (JSON.stringify(a) !== JSON.stringify(b)) { cambios++; assert.ok(permitidas.includes(j), `cambió columna ${despues[0][j]}`); }
  }));
  assert.strictEqual(cambios, 3);
  const f = filaAct(g, 'ACT-0165');
  assert.strictEqual(f[col(g, 'Actividades', 'Asistentes')], 42);
  const bit = g.hojas.Bitacora;
  assert.strictEqual(bit.length, 2);
  assert.deepStrictEqual(bit[1].slice(1), ['Roble 2', 'Roble 2', 'ACT-0165', '', 42]);
  assert.strictEqual(g.estado.escriturasSinLock, 0, 'hubo escrituras fuera del LockService');
});
prueba('Cambiar un número ya guardado queda en la bitácora con valor anterior y nuevo', () => {
  const g = entornoConPines();
  const t = tokenDe(g, 'Roble 2', '8888');
  g.post({ accion: 'guardarAsistencia', id: 'ACT-0166', valor: 30, token: t });
  g.post({ accion: 'guardarAsistencia', id: 'ACT-0166', valor: 35, token: t });
  const n = g.hojas.Bitacora.length;
  g.post({ accion: 'guardarAsistencia', id: 'ACT-0166', valor: 35, token: t }); // mismo valor: no se repite
  assert.strictEqual(g.hojas.Bitacora.length, n);
  assert.deepStrictEqual(g.hojas.Bitacora.slice(1).map((f) => [f[4], f[5]]), [['', 30], [30, 35]]);
});
prueba('Encargado NO puede guardar charlas de otro salón (el servidor lo rechaza)', () => {
  const g = entornoConPines();
  const t = tokenDe(g, 'Roble 2', '8888');
  const r = g.post({ accion: 'guardarAsistencia', id: 'ACT-0001', valor: 10, token: t });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.codigo, 'OTRO_SALON');
  assert.strictEqual(filaAct(g, 'ACT-0001')[col(g, 'Actividades', 'Asistentes')], '');
  assert.strictEqual(g.hojas.Bitacora.length, 1);
});
prueba('Valores inválidos se rechazan (negativos, decimales, texto, vacío)', () => {
  const g = entornoConPines();
  const t = tokenDe(g, 'Roble 2', '8888');
  ['-3', '4.5', 'abc', '', ' ', '1e3', null].forEach((v) => {
    const r = g.post({ accion: 'guardarAsistencia', id: 'ACT-0167', valor: v, token: t });
    assert.strictEqual(r.ok, false, 'aceptó ' + JSON.stringify(v));
  });
  assert.ok(g.post({ accion: 'guardarAsistencia', id: 'ACT-0167', valor: '0', token: t }).ok, 'debe aceptar 0');
});
prueba('guardarLote: guarda los válidos y reporta los inválidos uno por uno', () => {
  const g = entornoConPines();
  const t = tokenDe(g, 'Roble 2', '8888');
  const r = g.post({ accion: 'guardarLote', token: t, items: [
    { id: 'ACT-0169', valor: '20' }, { id: 'ACT-0170', valor: '21' }, { id: 'ACT-0001', valor: '5' },
    { id: 'ACT-9999', valor: '5' }, { id: 'ACT-0171', valor: 'x' }] });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.guardados, 2); assert.strictEqual(r.fallidos, 3);
  assert.deepStrictEqual(r.resultados.map((x) => x.ok), [true, true, false, false, false]);
  assert.strictEqual(g.hojas.Bitacora.length, 3);
});
prueba('Admin puede corregir cualquier salón y borrar un registro (queda en bitácora)', () => {
  const g = entornoConPines();
  const t = tokenDe(g, '', PIN_ADMIN);
  assert.ok(g.post({ accion: 'guardarAsistencia', id: 'ACT-0001', valor: 50, token: t }).ok);
  const r = g.post({ accion: 'guardarAsistencia', id: 'ACT-0001', valor: '', token: t });
  assert.ok(r.ok, r.error); assert.strictEqual(r.actividad.asistentes, null);
  assert.deepStrictEqual(g.hojas.Bitacora.slice(1).map((f) => [f[1], f[4], f[5]]), [['Administrador', '', 50], ['Administrador', 50, '']]);
  const tEnc = tokenDe(g, 'Cedro 1', '4444');
  assert.strictEqual(g.post({ accion: 'guardarAsistencia', id: 'ACT-0001', valor: '', token: tEnc }).ok, false, 'encargado no puede borrar');
});
prueba('Funciona aunque se muevan columnas o se agreguen nuevas (búsqueda por encabezado)', () => {
  const g = entornoConPines();
  // Mover "Asistentes" al inicio y agregar una columna nueva "Comentario" en medio.
  const A = g.hojas.Actividades;
  const iA = A[0].indexOf('Asistentes');
  A.forEach((f, i) => { const v = f.splice(iA, 1)[0]; f.unshift(v); f.splice(5, 0, i === 0 ? 'Comentario' : 'x'); });
  // Y reordenar filas: el sistema busca por ID, no por posición.
  const cab = A.shift(); A.reverse(); A.unshift(cab);
  const t = tokenDe(g, 'Roble 2', '8888');
  const r = g.post({ accion: 'guardarAsistencia', id: 'ACT-0172', valor: 77, token: t });
  assert.ok(r.ok, r.error);
  const f = A.find((x) => x[A[0].indexOf('ID')] === 'ACT-0172');
  assert.strictEqual(f[0], 77);
  assert.strictEqual(f[A[0].indexOf('Comentario')], 'x');
  const leido = g.post({ accion: 'getActividades', salon: 'Roble 2', dia: 'Martes', token: t });
  assert.strictEqual(leido.actividades.find((a) => a.id === 'ACT-0172').asistentes, 77);
  assert.strictEqual(leido.actividades[0].id, 'ACT-0165', 'el orden no debe depender de la posición de las filas');
});
prueba('Cambios hechos a mano en la hoja se ven en la siguiente lectura', () => {
  const g = entornoConPines();
  const t = tokenDe(g, 'Roble 2', '8888');
  const f = filaAct(g, 'ACT-0173');
  f[col(g, 'Actividades', 'Charla')] = 'Título corregido a mano';
  f[col(g, 'Actividades', 'Correo')] = 'nuevo@correo.cr';
  const r = g.post({ accion: 'getActividades', salon: 'Roble 2', dia: 'Martes', token: t });
  const a = r.actividades.find((x) => x.id === 'ACT-0173');
  assert.strictEqual(a.charla, 'Título corregido a mano');
  assert.strictEqual(a.expositores.personas[0].correo, 'nuevo@correo.cr');
});

console.log('\n4b) Personal de apoyo (sin PIN)');
prueba('getTodo: 527 charlas de los salones activos, sin PINes, en una sola petición', () => {
  const g = entornoConPines();
  const r = g.post({ accion: 'getTodo' });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.actividades.length, 527);
  assert.strictEqual(r.salones.length, 10);
  const txt = JSON.stringify(r);
  Object.values(PINES).concat([PIN_ADMIN]).forEach((p) => assert.ok(!txt.includes('"' + p + '"'), 'aparece PIN ' + p));
  g.hojas.Salones.find((f) => f[0] === 'Laurel 1')[3] = false;
  const r2 = g.post({ accion: 'getTodo' });
  assert.ok(!r2.actividades.some((a) => a.salon === 'Laurel 1'), 'un salón inactivo no debe aparecer');
});
prueba('Sin PIN se puede guardar en cualquier salón; queda el nombre de quien registró', () => {
  const g = entornoConPines();
  g.fijarAhora('2026-11-10T16:42:00Z');
  const r1 = g.post({ accion: 'guardarAsistencia', id: 'ACT-0001', valor: '25', usuario: '  Ana   Mora ' });
  assert.ok(r1.ok, r1.error);
  assert.strictEqual(r1.actividad.registradoPor, 'Ana Mora');
  const r2 = g.post({ accion: 'guardarAsistencia', id: 'ACT-0165', valor: '30' });
  assert.ok(r2.ok, r2.error);
  assert.strictEqual(r2.actividad.registradoPor, 'Roble 2', 'sin nombre se anota el salón');
  assert.deepStrictEqual(plano(g.hojas.Bitacora.slice(1).map((f) => [f[1], f[2], f[3]])),
    [['Ana Mora', 'Cedro 1', 'ACT-0001'], ['Personal de apoyo', 'Roble 2', 'ACT-0165']]);
  const r3 = g.post({ accion: 'guardarAsistencia', id: 'ACT-0002', valor: '1', usuario: '=HYPERLINK("x")' });
  assert.ok(r3.ok);
  assert.ok(String(g.hojas.Bitacora[3][1]).startsWith("'="), 'un nombre que empieza con = no debe quedar como fórmula');
});
prueba('Personal de apoyo: no puede borrar registros ni guardar con la edición bloqueada', () => {
  const g = entornoConPines();
  assert.ok(g.post({ accion: 'guardarAsistencia', id: 'ACT-0003', valor: '9' }).ok);
  assert.strictEqual(g.post({ accion: 'guardarAsistencia', id: 'ACT-0003', valor: '' }).ok, false);
  const tA = tokenDe(g, '', PIN_ADMIN);
  g.post({ accion: 'setBloqueo', valor: 'SI', token: tA });
  const r = g.post({ accion: 'guardarLote', items: [{ id: 'ACT-0004', valor: '3' }] });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.codigo, 'BLOQUEADO');
});
prueba('Token falso enviado sin PIN real se rechaza (no cae a "personal de apoyo")', () => {
  const g = entornoConPines();
  const r = g.post({ accion: 'guardarAsistencia', id: 'ACT-0005', valor: '2', token: 'x|admin|y|9999999999999|firma' });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.codigo, 'SESION');
  assert.strictEqual(g.post({ accion: 'getResumenAdmin' }).ok, false, 'el panel admin sigue pidiendo PIN');
});

console.log('\n5) Bloqueo y administración');
prueba('Bloquear_edicion = SI: encargado no guarda, admin sí; solo admin cambia el bloqueo', () => {
  const g = entornoConPines();
  const tA = tokenDe(g, '', PIN_ADMIN);
  const tE = tokenDe(g, 'Roble 2', '8888');
  assert.strictEqual(g.post({ accion: 'setBloqueo', valor: 'SI', token: tE }).ok, false);
  assert.ok(g.post({ accion: 'setBloqueo', valor: 'SI', token: tA }).bloqueo);
  assert.strictEqual(g.hojas.Config.find((f) => f[0] === 'Bloquear_edicion')[1], 'SI');
  const r = g.post({ accion: 'guardarAsistencia', id: 'ACT-0165', valor: 3, token: tE });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.codigo, 'BLOQUEADO');
  const v = g.post({ accion: 'getActividades', salon: 'Roble 2', token: tE });
  assert.strictEqual(v.puedeGuardar, false);
  assert.ok(g.post({ accion: 'guardarAsistencia', id: 'ACT-0165', valor: 3, token: tA }).ok);
  assert.strictEqual(g.post({ accion: 'setBloqueo', valor: 'NO', token: tA }).bloqueo, false);
  assert.ok(g.post({ accion: 'guardarAsistencia', id: 'ACT-0165', valor: 4, token: tE }).ok);
  assert.ok(g.hojas.Bitacora.some((f) => f[3] === 'Bloquear_edicion' && f[5] === 'SI'));
});
prueba('Resumen admin: requiere PIN admin, no incluye PINes, trae enlace a la hoja', () => {
  const g = entornoConPines();
  const tE = tokenDe(g, 'Roble 2', '8888');
  assert.strictEqual(g.post({ accion: 'getResumenAdmin', token: tE }).ok, false);
  assert.strictEqual(g.post({ accion: 'getBitacora', token: tE }).ok, false);
  const r = g.post({ accion: 'getResumenAdmin', token: tokenDe(g, '', PIN_ADMIN) });
  assert.ok(r.ok); assert.strictEqual(r.actividades.length, 527);
  assert.match(r.urlHoja, /docs\.google\.com/);
  const txt = JSON.stringify(r);
  Object.values(PINES).forEach((p) => assert.ok(!txt.includes('"' + p + '"')));
  assert.ok(!txt.includes(PIN_ADMIN));
});
prueba('Charlas atrasadas y "hoy" con Config → Fecha_inicio', () => {
  const g = entornoConPines();
  g.hojas.Config.push(['Fecha_inicio', g.fecha('2026-11-09T06:00:00Z')]); // lunes 9 nov (fecha de ejemplo)
  g.fijarAhora('2026-11-10T17:00:00Z'); // martes 10, 11:00 a.m. Costa Rica
  const t = tokenDe(g, '', PIN_ADMIN);
  const r = g.post({ accion: 'getResumenAdmin', token: t });
  assert.strictEqual(r.hoy, 'Martes');
  const at = new Set(r.actividades.filter((a) => a.atrasada).map((a) => a.id));
  assert.ok(r.actividades.filter((a) => a.dia === 'Lunes').every((a) => at.has(a.id)), 'todo el lunes debería estar atrasado');
  ['ACT-0165', 'ACT-0168', 'ACT-0169'].forEach((id) => assert.ok(at.has(id), id + ' terminó y no tiene registro'));
  ['ACT-0170', 'ACT-0173'].forEach((id) => assert.ok(!at.has(id), id + ' aún no termina'));
  assert.ok(!r.actividades.some((a) => a.dia === 'Miércoles' && a.atrasada));
  g.post({ accion: 'guardarAsistencia', id: 'ACT-0165', valor: 9, token: t });
  const r2 = g.post({ accion: 'getResumenAdmin', token: t });
  assert.ok(!r2.actividades.find((a) => a.id === 'ACT-0165').atrasada);
  // Fuera de las fechas del congreso, "hoy" es null.
  g.fijarAhora('2026-09-30T17:00:00Z');
  assert.strictEqual(g.post({ accion: 'getSalones' }).hoy, null);
});
prueba('Bitácora: la devuelve del más reciente al más antiguo', () => {
  const g = entornoConPines();
  const t = tokenDe(g, '', PIN_ADMIN);
  g.post({ accion: 'guardarAsistencia', id: 'ACT-0010', valor: 1, token: t });
  g.post({ accion: 'guardarAsistencia', id: 'ACT-0011', valor: 2, token: t });
  const r = g.post({ accion: 'getBitacora', token: t });
  assert.ok(r.ok); assert.strictEqual(r.total, 2);
  assert.deepStrictEqual(r.registros.map((b) => b.id), ['ACT-0011', 'ACT-0010']);
});

console.log(`\n${pasadas} pruebas pasaron, ${fallos.length} fallaron.`);
if (fallos.length) process.exit(1);
