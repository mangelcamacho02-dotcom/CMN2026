/**
 * Simulador mínimo de Google Apps Script para probar Code.gs en Node,
 * usando los datos reales del Excel (pruebas/datos_prueba.json).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const RAIZ = path.join(__dirname, '..');

function crearEntorno(opciones) {
  opciones = opciones || {};
  const datos = JSON.parse(fs.readFileSync(opciones.datos || path.join(__dirname, 'datos_prueba.json'), 'utf8'));
  const ctx = vm.createContext({ console });

  // Reloj controlable dentro del contexto.
  vm.runInContext(`(function(){
    const RD = Date; let fijo = null;
    class FD extends RD {
      constructor(...a) { if (!a.length && fijo !== null) super(fijo); else super(...a); }
      static now() { return fijo !== null ? fijo : RD.now(); }
    }
    globalThis.Date = FD;
    globalThis.__fijarAhora = (t) => { fijo = t; };
    globalThis.__fecha = (iso) => new FD(iso);
  })()`, ctx);

  const estado = { lockTomado: false, escriturasSinLock: 0, cache: new Map(), props: new Map() };

  function aValor(x) {
    if (x === null || x === undefined) return '';
    if (typeof x === 'object' && x.$date) return ctx.__fecha(x.$date);
    return x;
  }
  const hojas = {};
  Object.keys(datos).forEach((n) => { hojas[n] = datos[n].map((f) => f.map(aValor)); });

  function hojaMock(nombre) {
    const filas = () => hojas[nombre];
    const ancho = () => Math.max(0, ...filas().map((f) => f.length));
    const marcarEscritura = () => {
      if (!estado.lockTomado && (nombre === 'Actividades' || nombre === 'Bitacora' || nombre === 'Config')) estado.escriturasSinLock++;
    };
    const setCelda = (r, c, v) => {
      const f = filas();
      while (f.length < r) f.push([]);
      const fila = f[r - 1];
      while (fila.length < c) fila.push('');
      fila[c - 1] = v;
    };
    return {
      getName: () => nombre,
      getDataRange: () => ({
        getValues: () => {
          const w = ancho();
          return filas().map((f) => { const c = f.slice(); while (c.length < w) c.push(''); return c; });
        }
      }),
      getLastRow: () => {
        const f = filas();
        for (let i = f.length - 1; i >= 0; i--) if (f[i].some((x) => x !== '' && x !== null)) return i + 1;
        return 0;
      },
      getRange: (r, c, nr, nc) => ({
        setValue: (v) => { marcarEscritura(); setCelda(r, c, v); },
        setValues: (vals) => {
          marcarEscritura();
          if (vals.length !== (nr || 1) || vals[0].length !== (nc || 1)) throw new Error('Dimensiones incorrectas en setValues');
          vals.forEach((fila, i) => fila.forEach((v, j) => setCelda(r + i, c + j, v)));
        },
        getValue: () => ((filas()[r - 1] || [])[c - 1] ?? '')
      }),
      appendRow: (fila) => { marcarEscritura(); filas().push(fila.slice()); }
    };
  }

  ctx.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: (n) => (hojas[n] ? hojaMock(n) : null),
      getUrl: () => 'https://docs.google.com/spreadsheets/d/PRUEBA/edit',
      getSpreadsheetTimeZone: () => 'America/Costa_Rica'
    }),
    flush: () => {}
  };
  ctx.LockService = {
    getScriptLock: () => ({
      tryLock: () => { if (estado.lockTomado) return false; estado.lockTomado = true; return true; },
      waitLock: () => { estado.lockTomado = true; },
      releaseLock: () => { estado.lockTomado = false; }
    })
  };
  ctx.CacheService = {
    getScriptCache: () => ({
      get: (k) => (estado.cache.has(k) ? estado.cache.get(k) : null),
      put: (k, v) => { estado.cache.set(k, String(v)); },
      remove: (k) => { estado.cache.delete(k); }
    })
  };
  ctx.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (estado.props.has(k) ? estado.props.get(k) : null),
      setProperty: (k, v) => { estado.props.set(k, v); }
    })
  };
  ctx.Utilities = {
    formatDate: (d, tz, patron) => {
      const partes = {};
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        weekday: 'short', hour12: false
      }).formatToParts(new Date(d.getTime())).forEach((p) => { partes[p.type] = p.value; });
      const H = parseInt(partes.hour, 10) % 24;
      const u = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[partes.weekday];
      return patron.replace(/yyyy|MM|dd|HH|mm|u|h|a/g, (t) => ({
        yyyy: partes.year, MM: partes.month, dd: partes.day, HH: String(H).padStart(2, '0'),
        mm: partes.minute, u: String(u), h: String(H % 12 || 12), a: H < 12 ? 'AM' : 'PM'
      }[t]));
    },
    computeHmacSha256Signature: (valor, clave) =>
      Array.from(crypto.createHmac('sha256', clave).update(valor, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
    base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => b & 255)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    getUuid: () => crypto.randomUUID()
  };
  ctx.ContentService = {
    MimeType: { JSON: 'JSON' },
    createTextOutput: (s) => ({ setMimeType() { return this; }, getContent: () => s })
  };
  ctx.Logger = { log: (...a) => { if (opciones.verbose) console.log(...a); } };

  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });

  return {
    ctx,
    hojas,
    estado,
    fijarAhora: (iso) => ctx.__fijarAhora(iso ? new Date(iso).getTime() : null),
    fecha: (iso) => ctx.__fecha(iso),
    /** Simula una petición POST como la del navegador. */
    post: (obj) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(obj) } }).getContent()),
    get: (params) => JSON.parse(ctx.doGet({ parameter: params }).getContent())
  };
}

module.exports = { crearEntorno };
