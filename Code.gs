/**
 * ============================================================================
 *  ESTE es el archivo que va en Apps Script (Extensiones → Apps Script).
 *  La primera línea de código debe ser:  var ZONA_HORARIA = 'America/Costa_Rica';
 *  (app.js, index.html y styles.css van en GitHub, NO aquí).
 * ============================================================================
 *  CMN 2026 — Registro de asistencia por charla
 *  Backend (Google Apps Script) vinculado a la hoja "BD_Asistencia_CMN2026".
 * ============================================================================
 *
 *  Este script funciona como una API JSON. El frontend (GitHub Pages) le hace
 *  peticiones con fetch:
 *
 *    POST  <URL de la app web>   cuerpo: {"accion": "...", ...parámetros}
 *    GET   <URL de la app web>?accion=getSalones        (solo lecturas públicas)
 *
 *  Reglas importantes:
 *   - La hoja ES la base de datos. Todo se lee de la hoja en cada petición,
 *     así que cualquier cambio manual se ve al recargar la página.
 *   - Las columnas se buscan por el NOMBRE del encabezado (fila 1), nunca por
 *     la letra. Se pueden agregar o mover columnas sin romper nada.
 *   - Las filas de Actividades se buscan siempre por su ID (ACT-0001...).
 *   - El sistema solo escribe en: Asistentes, Registrado_por, Fecha_registro
 *     (hoja Actividades), en la hoja Bitacora y en Config → Bloquear_edicion.
 *     Además, cuando el personal lo pide expresamente desde la página:
 *     Expositor, Codigo_medico, Correo y Estado (editar expositor) y
 *     Hora y Orden (mover una charla). Todo queda en la Bitacora.
 *   - Toda escritura se hace dentro de un LockService para que varios
 *     encargados puedan guardar al mismo tiempo sin pisarse.
 *   - Registrar asistencia NO requiere PIN (solo lo usa el personal de apoyo).
 *     El PIN de administrador (Config → PIN_admin) protege el panel de
 *     administración: correcciones, borrar registros, bloqueo y bitácora.
 *     Los PINes nunca se envían al navegador; al entrar con el PIN correcto
 *     el servidor entrega una "sesión" firmada (token).
 *
 *  Si modifica este archivo, recuerde volver a publicar:
 *    Implementar → Gestionar implementaciones → (lápiz) → Versión: "Nueva versión".
 */

// ---------------------------------------------------------------------------
//  Configuración general (no son datos del congreso: esos están en la hoja)
// ---------------------------------------------------------------------------

/** Zona horaria usada para "hoy", la hora actual y las horas de registro. */
/** Versión de este archivo. Al abrir la URL de la app web debe aparecer este número. */
var VERSION = '2026-10-09 editar y mover';

var ZONA_HORARIA = 'America/Costa_Rica';

/** Nombres de las hojas. */
var HOJA_ACTIVIDADES = 'Actividades';
var HOJA_SALONES = 'Salones';
var HOJA_CONFIG = 'Config';
var HOJA_BITACORA = 'Bitacora';

/** Texto que se muestra como autor cuando guarda el administrador. */
var USUARIO_ADMIN = 'Administrador';

/** PINes que se consideran "sin configurar" (no permiten entrar). */
var PINES_INVALIDOS = ['', 'CAMBIAR'];

/** Protección contra adivinar PINes: intentos fallidos permitidos y bloqueo. */
var MAX_INTENTOS_FALLIDOS = 15;
var SEGUNDOS_BLOQUEO_PIN = 300;

/** Duración de una sesión (horas). Después hay que volver a digitar el PIN. */
var HORAS_SESION = 18;

/** Tiempo máximo (ms) esperando el turno para escribir. */
var ESPERA_LOCK_MS = 25000;

/** Días de la semana en español (índice = Date.getDay()). */
var NOMBRES_DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];


// ===========================================================================
//  PUNTOS DE ENTRADA DE LA APLICACIÓN WEB
// ===========================================================================

/**
 * Peticiones GET. Se aceptan solo acciones de lectura que no llevan PIN
 * (para no dejar PINes en el historial del navegador). Útil para probar que
 * la publicación funciona: abra la URL con ?accion=getSalones
 */
function doGet(e) {
  var p = (e && e.parameter) || {};
  // Tolera caracteres de más al copiar la URL (comillas, puntos, espacios, mayúsculas).
  var recibido = String(p.accion || '');
  var accion = recibido.replace(/[^A-Za-z]/g, '').toLowerCase();
  if (!accion || accion === 'ping') {
    p.accion = 'ping';
  } else if (accion === 'getsalones') {
    p.accion = 'getSalones';
  } else {
    return responderJson_({ ok: false, error: 'Por GET solo se permite ?accion=getSalones (se recibió "' + recibido +
      '"). Las demás acciones se usan desde la página con POST.' });
  }
  return responderJson_(ejecutarAccion_(p));
}

/**
 * Peticiones POST. El cuerpo es un JSON: {"accion": "...", ...}.
 * El frontend lo envía como text/plain para evitar el "preflight" CORS,
 * que Apps Script no soporta.
 */
function doPost(e) {
  var datos = {};
  try {
    datos = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return responderJson_({ ok: false, error: 'Petición inválida (JSON mal formado).' });
  }
  return responderJson_(ejecutarAccion_(datos));
}

/** Enruta la acción pedida a su función. Nunca lanza: siempre devuelve JSON. */
function ejecutarAccion_(p) {
  try {
    switch (p.accion) {
      case 'ping':              return { ok: true, mensaje: 'API CMN 2026 activa', version: VERSION, ahora: ahora_().iso };
      case 'getSalones':        return getSalones();
      case 'getTodo':           return getTodo();
      case 'login':             return login(p.salon, p.pin);
      case 'getActividades':    return getActividades(p.salon, p.dia, p.token);
      case 'guardarAsistencia': return guardarAsistencia(p.id, p.valor, p.token, p.usuario);
      case 'guardarLote':       return guardarLote(p.items, p.token, p.usuario);
      case 'editarExpositor':   return editarExpositor(p.id, p.personas, p.token, p.usuario);
      case 'moverCharla':       return moverCharla(p.id, p.direccion, p.token, p.usuario);
      case 'getResumenAdmin':   return getResumenAdmin(p.token);
      case 'getBitacora':       return getBitacora(p.token, p.limite);
      case 'setBloqueo':        return setBloqueo(p.valor, p.token);
      default:                  return { ok: false, error: 'Acción desconocida: ' + p.accion };
    }
  } catch (err) {
    // Errores "esperados" (PIN malo, dato inválido...) llevan err.publico = true.
    var msg = err && err.publico ? err.message : 'Error del servidor: ' + (err && err.message ? err.message : err);
    return { ok: false, error: msg, codigo: (err && err.codigo) || 'ERROR' };
  }
}

function responderJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}


// ===========================================================================
//  ENDPOINTS
// ===========================================================================

/**
 * getSalones — pantalla de inicio (público, sin PIN).
 * Devuelve el nombre del evento, los días, el estado del bloqueo y la lista
 * de salones activos con su avance (charlas registradas / total).
 */
function getSalones() {
  var config = leerConfig_();
  var salones = leerSalones_();
  var acts = leerActividades_();
  var dias = config.dias;

  var lista = salones.filter(function (s) { return s.activo; }).map(function (s) {
    var propias = acts.filter(function (a) { return mismoTexto_(a.salon, s.salon); });
    var diasConActividad = dias.filter(function (d) {
      return propias.some(function (a) { return mismoTexto_(a.dia, d); });
    });
    return {
      salon: s.salon,
      total: propias.length,
      registradas: propias.filter(function (a) { return a.asistentes !== null; }).length,
      dias: diasConActividad
    };
  });

  return {
    ok: true,
    evento: config.evento,
    dias: dias,
    bloqueo: config.bloqueo,
    hoy: infoHoy_(config).dia,
    salones: lista
  };
}

/**
 * login — valida el PIN de un salón (o el PIN de administrador) y entrega
 * un token de sesión.
 *  - salon vacío: solo se acepta el PIN de administrador (botón "Administrador").
 *  - salon con nombre: se acepta el PIN de ese salón o el PIN de administrador.
 */
function login(salon, pin) {
  var sesion = autenticarPin_(salon, pin);
  var config = leerConfig_();
  return {
    ok: true,
    rol: sesion.rol,
    salon: sesion.salon,
    usuario: sesion.usuario,
    bloqueo: config.bloqueo,
    token: crearToken_(sesion)
  };
}

/**
 * getActividades — charlas de un salón (requiere PIN del salón o de admin).
 * Si se indica `dia`, filtra por ese día; si no, devuelve todos los días
 * del salón (así el celular puede cambiar de día sin volver a cargar).
 */
function getActividades(salon, dia, token) {
  var sesion = sesionDe_(token, '');
  // Personal de apoyo y administrador pueden pedir cualquier salón.
  if (sesion.rol !== 'encargado') {
    var ficha = leerSalones_().filter(function (s) { return mismoTexto_(s.salon, salon); })[0];
    if (!ficha) throw errorPublico_('El salón "' + texto_(salon) + '" no existe.', 'SALON');
    sesion.salon = ficha.salon;
  } else if (salon && !mismoTexto_(salon, sesion.salon)) {
    throw errorPublico_('Su sesión es del salón ' + sesion.salon + ', no de ' + texto_(salon) + '.', 'SESION');
  }
  var config = leerConfig_();
  var hoy = infoHoy_(config);
  var acts = leerActividades_().filter(function (a) { return mismoTexto_(a.salon, sesion.salon); });

  var diasSalon = config.dias.map(function (d) {
    return { dia: d, activo: acts.some(function (a) { return mismoTexto_(a.dia, d); }) };
  });
  if (dia) acts = acts.filter(function (a) { return mismoTexto_(a.dia, dia); });

  return {
    ok: true,
    salon: sesion.salon,
    rol: sesion.rol,
    usuario: sesion.usuario,
    evento: config.evento,
    bloqueo: config.bloqueo,
    puedeGuardar: sesion.rol === 'admin' || !config.bloqueo,
    hoy: hoy.dia,
    dias: diasSalon,
    actividades: ordenarActividades_(acts, config.dias).map(function (a) { return actividadPublica_(a, hoy, config); })
  };
}

/**
 * editarExpositor — cambia nombre(s), código(s) y correo(s) del expositor
 * de una charla. personas = [{nombre, codigo, correo}, ...]
 * Varias personas se guardan separadas por " / " (como en la hoja).
 * Si no queda ningún nombre, la charla vuelve a "PENDIENTE".
 * Queda en la Bitacora con el valor anterior y el nuevo.
 */
function editarExpositor(id, personas, token, usuario) {
  var sesion = sesionDe_(token, usuario);
  var limpias = validarPersonas_(personas);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(ESPERA_LOCK_MS)) throw errorPublico_('El sistema está ocupado. Intente de nuevo.', 'OCUPADO');
  try {
    var config = leerConfig_();
    if (config.bloqueo && sesion.rol !== 'admin') {
      throw errorPublico_('La edición está bloqueada por el administrador. Solo puede consultar.', 'BLOQUEADO');
    }
    var t = leerTabla_(HOJA_ACTIVIDADES, ['ID', 'Salon', 'Expositor', 'Codigo_medico', 'Correo', 'Estado']);
    var i = indicePorId_(t, id);
    var fila = t.filas[i];
    var c = t.col;
    var antes = resumenExpositor_(fila[c.Expositor], fila[c.Codigo_medico], fila[c.Correo]);
    var nombres = limpias.map(function (p) { return p.nombre; }).join(' / ');
    var codigos = limpias.some(function (p) { return p.codigo; }) ? limpias.map(function (p) { return p.codigo || '—'; }).join(' / ') : '';
    var correos = limpias.some(function (p) { return p.correo; }) ? limpias.map(function (p) { return p.correo || '—'; }).join(' / ') : '';
    var nuevo = {
      Expositor: nombres || 'PENDIENTE',
      Codigo_medico: codigos,
      Correo: correos,
      Estado: nombres ? 'CONFIRMADO' : 'PENDIENTE'
    };
    var numFila = i + 2;
    Object.keys(nuevo).forEach(function (k) {
      t.hoja.getRange(numFila, c[k] + 1).setValue(seguroHoja_(nuevo[k]));
      fila[c[k]] = nuevo[k];
    });
    var despues = resumenExpositor_(nuevo.Expositor, nuevo.Codigo_medico, nuevo.Correo);
    if (antes !== despues) {
      agregarBitacora_([{ Fecha: new Date(), Usuario: sesion.usuario || 'Personal de apoyo', Salon: texto_(fila[c.Salon]),
                          ID_actividad: texto_(fila[c.ID]).toUpperCase(), Valor_anterior: antes, Valor_nuevo: despues }]);
    }
    SpreadsheetApp.flush();
    return { ok: true, actividad: actividadPublica_(filaAObjeto_(fila, t.encabezados), infoHoy_(config), config) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * moverCharla — sube (direccion = -1) o baja (+1) una charla dentro de su
 * simposio. La charla intercambia su lugar con la vecina: se intercambian
 * Hora y Orden, así los horarios del programa quedan iguales y lo que cambia
 * es qué charla va en cada horario.
 */
function moverCharla(id, direccion, token, usuario) {
  var sesion = sesionDe_(token, usuario);
  var dir = Number(direccion) < 0 ? -1 : 1;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(ESPERA_LOCK_MS)) throw errorPublico_('El sistema está ocupado. Intente de nuevo.', 'OCUPADO');
  try {
    var config = leerConfig_();
    if (config.bloqueo && sesion.rol !== 'admin') {
      throw errorPublico_('La edición está bloqueada por el administrador. Solo puede consultar.', 'BLOQUEADO');
    }
    var t = leerTabla_(HOJA_ACTIVIDADES, ['ID', 'Dia', 'Salon', 'Hora', 'Simposio', 'Entidad']);
    var c = t.col;
    var iOrden = buscarColumna_(t.encabezados, 'Orden');
    var i = indicePorId_(t, id);
    var fila = t.filas[i];
    // Charlas del mismo salón y día, en el mismo orden en que se muestran.
    var mismas = [];
    t.filas.forEach(function (f, k) {
      if (texto_(f[c.ID]) && mismoTexto_(f[c.Salon], fila[c.Salon]) && mismoTexto_(f[c.Dia], fila[c.Dia])) {
        var h = parsearHora_(f[c.Hora]);
        mismas.push({ k: k, inicio: h.inicio === null ? 9999 : h.inicio, orden: iOrden >= 0 ? Number(f[iOrden]) || 0 : 0 });
      }
    });
    mismas.sort(function (a, b) { return (a.inicio - b.inicio) || (a.orden - b.orden); });
    var pos = mismas.map(function (m) { return m.k; }).indexOf(i);
    var vecina = mismas[pos + dir];
    var bloque = function (f) { return normalizar_(f[c.Simposio]) + '|' + normalizar_(f[c.Entidad]); };
    if (!vecina || bloque(t.filas[vecina.k]) !== bloque(fila)) {
      throw errorPublico_(dir < 0 ? 'Ya es la primera charla de su simposio.' : 'Ya es la última charla de su simposio.', 'MOVER');
    }
    var j = vecina.k;
    var otra = t.filas[j];
    var horaI = fila[c.Hora], horaJ = otra[c.Hora];
    var ordI = iOrden >= 0 ? fila[iOrden] : '', ordJ = iOrden >= 0 ? otra[iOrden] : '';
    t.hoja.getRange(i + 2, c.Hora + 1).setValue(horaJ);
    t.hoja.getRange(j + 2, c.Hora + 1).setValue(horaI);
    fila[c.Hora] = horaJ; otra[c.Hora] = horaI;
    if (iOrden >= 0) {
      t.hoja.getRange(i + 2, iOrden + 1).setValue(ordJ);
      t.hoja.getRange(j + 2, iOrden + 1).setValue(ordI);
      fila[iOrden] = ordJ; otra[iOrden] = ordI;
    }
    var quien = sesion.usuario || 'Personal de apoyo';
    var ahora = new Date();
    agregarBitacora_([
      { Fecha: ahora, Usuario: quien, Salon: texto_(fila[c.Salon]), ID_actividad: texto_(fila[c.ID]).toUpperCase(),
        Valor_anterior: 'Hora: ' + texto_(horaI), Valor_nuevo: 'Hora: ' + texto_(horaJ) },
      { Fecha: ahora, Usuario: quien, Salon: texto_(otra[c.Salon]), ID_actividad: texto_(otra[c.ID]).toUpperCase(),
        Valor_anterior: 'Hora: ' + texto_(horaJ), Valor_nuevo: 'Hora: ' + texto_(horaI) }
    ]);
    SpreadsheetApp.flush();
    var hoy = infoHoy_(config);
    return { ok: true, actividades: [fila, otra].map(function (f) { return actividadPublica_(filaAObjeto_(f, t.encabezados), hoy, config); }) };
  } finally {
    lock.releaseLock();
  }
}

/** Revisa los datos de expositores que vienen del navegador. */
function validarPersonas_(personas) {
  if (!Array.isArray(personas)) throw errorPublico_('Datos de expositor inválidos.', 'DATOS');
  if (personas.length > 8) throw errorPublico_('Máximo 8 expositores por charla.', 'DATOS');
  var limpio = function (v, max) { return texto_(v).replace(/[\u0000-\u001f]/g, '').replace(/\s*\/\s*/g, ' ').replace(/\s+/g, ' ').slice(0, max); };
  return personas.map(function (p) {
    p = p || {};
    return { nombre: limpio(p.nombre, 120), codigo: limpio(p.codigo, 30), correo: limpio(p.correo, 120).toLowerCase() };
  }).filter(function (p) { return p.nombre || p.codigo || p.correo; }).map(function (p) {
    if (!p.nombre) throw errorPublico_('Falta el nombre del expositor (código ' + (p.codigo || '—') + ').', 'DATOS');
    if (p.correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.correo)) throw errorPublico_('El correo "' + p.correo + '" no es válido.', 'DATOS');
    return p;
  });
}

function resumenExpositor_(exp, cod, cor) {
  return 'Expositor: ' + (texto_(exp) || '—') + ' · Cód: ' + (texto_(cod) || '—') + ' · Correo: ' + (texto_(cor) || '—');
}

/** Fila (índice en t.filas) de una actividad, buscando por ID. */
function indicePorId_(t, id) {
  var buscado = texto_(id).toUpperCase();
  for (var i = 0; i < t.filas.length; i++) {
    if (texto_(t.filas[i][t.col.ID]).toUpperCase() === buscado && buscado) return i;
  }
  throw errorPublico_('No existe la actividad ' + (buscado || '(sin ID)') + '.', 'NO_EXISTE');
}

function buscarColumna_(encabezados, nombre) {
  for (var i = 0; i < encabezados.length; i++) if (mismoTexto_(encabezados[i], nombre)) return i;
  return -1;
}

/** Evita que un texto que empieza con = + - @ se tome como fórmula. */
function seguroHoja_(v) {
  return /^[=+\-@]/.test(String(v)) ? "'" + v : v;
}

/**
 * getTodo — todo lo que necesita la pantalla del personal de apoyo en UNA
 * sola petición: evento, días, salones activos y todas sus charlas.
 * (No incluye PINes.) Así cambiar de salón o de día es instantáneo.
 */
function getTodo() {
  var config = leerConfig_();
  var hoy = infoHoy_(config);
  var salones = leerSalones_().filter(function (s) { return s.activo; });
  var acts = leerActividades_().filter(function (a) {
    return salones.some(function (s) { return mismoTexto_(s.salon, a.salon); });
  });
  return {
    ok: true,
    evento: config.evento,
    dias: config.dias,
    bloqueo: config.bloqueo,
    hoy: hoy.dia,
    ahora: hoy.iso,
    salones: salones.map(function (s) { return { salon: s.salon, encargado: s.encargado }; }),
    actividades: ordenarActividades_(acts, config.dias).map(function (a) { return actividadPublica_(a, hoy, config); })
  };
}

/** guardarAsistencia — guarda un solo valor. Es un lote de un elemento. */
function guardarAsistencia(id, valor, token, usuario) {
  var r = guardarLote([{ id: id, valor: valor }], token, usuario);
  var res = r.resultados[0];
  if (!res.ok) return { ok: false, error: res.error, codigo: res.codigo, id: id };
  return { ok: true, actividad: res.actividad, cambio: res.cambio };
}

/**
 * guardarLote — guarda varios valores de una vez: items = [{id, valor}, ...].
 * Todo ocurre dentro de un único bloqueo (LockService). Cada elemento se
 * valida por separado: un error en uno no impide guardar los demás.
 *
 * Reglas:
 *  - valor: entero ≥ 0. El administrador además puede enviar "" para borrar.
 *  - Sin token = personal de apoyo (puede guardar en cualquier salón).
 *    `usuario` es el nombre que la persona escribió (opcional) y queda en
 *    Registrado_por y en la Bitacora.
 *  - Si Config → Bloquear_edicion = SI, solo el administrador puede guardar.
 *  - Cada cambio se anota en la Bitacora con el valor anterior y el nuevo.
 */
function guardarLote(items, token, usuario) {
  var sesion = sesionDe_(token, usuario);
  if (!Array.isArray(items) || !items.length) throw errorPublico_('No hay datos para guardar.', 'DATOS');
  if (items.length > 500) throw errorPublico_('Demasiados elementos en un solo lote.', 'DATOS');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(ESPERA_LOCK_MS)) {
    throw errorPublico_('El sistema está ocupado guardando otros datos. Intente de nuevo.', 'OCUPADO');
  }
  try {
    // Se relee todo DENTRO del bloqueo para trabajar con los datos más recientes.
    var config = leerConfig_();
    if (config.bloqueo && sesion.rol !== 'admin') {
      throw errorPublico_('La edición está bloqueada por el administrador. Solo puede consultar.', 'BLOQUEADO');
    }
    var tabla = leerTabla_(HOJA_ACTIVIDADES, ['ID', 'Salon', 'Asistentes', 'Registrado_por', 'Fecha_registro']);
    var hoja = tabla.hoja;
    var col = tabla.col;
    var ahora = new Date();
    var hoy = infoHoy_(config);

    // Índice ID → número de fila en la hoja (siempre por ID, nunca por posición).
    var filaPorId = {};
    tabla.filas.forEach(function (f, i) {
      var id = texto_(f[col.ID]).toUpperCase();
      if (id) filaPorId[id] = i;
    });

    var bitacora = [];
    var resultados;
    try {
      resultados = items.map(function (it) {
        var id = texto_(it && it.id).toUpperCase();
        try {
          if (!id || !(id in filaPorId)) throw errorPublico_('No existe la actividad ' + (id || '(sin ID)') + '.', 'NO_EXISTE');
          var i = filaPorId[id];
          var fila = tabla.filas[i];
          if (sesion.rol === 'encargado' && !mismoTexto_(fila[col.Salon], sesion.salon)) {
            throw errorPublico_('La actividad ' + id + ' no pertenece al salón ' + sesion.salon + '.', 'OTRO_SALON');
          }
          var nuevo = validarValor_(it.valor, sesion.rol === 'admin');
          var anterior = numeroONulo_(fila[col.Asistentes]);
          // Quién registró: el nombre escrito; si no hay, el salón.
          var quien = sesion.usuario || texto_(fila[col.Salon]);
          var numFila = i + 2; // +1 por el encabezado, +1 porque la hoja empieza en 1
          var cambio = anterior !== nuevo;

          if (cambio) {
            hoja.getRange(numFila, col.Asistentes + 1).setValue(nuevo === null ? '' : nuevo);
            hoja.getRange(numFila, col.Registrado_por + 1).setValue(nuevo === null ? '' : quien);
            hoja.getRange(numFila, col.Fecha_registro + 1).setValue(nuevo === null ? '' : ahora);
            fila[col.Asistentes] = nuevo === null ? '' : nuevo;
            fila[col.Registrado_por] = nuevo === null ? '' : quien;
            fila[col.Fecha_registro] = nuevo === null ? '' : ahora;
            bitacora.push({
              Fecha: ahora,
              Usuario: sesion.usuario || 'Personal de apoyo',
              Salon: texto_(fila[col.Salon]),
              ID_actividad: id,
              Valor_anterior: anterior === null ? '' : anterior,
              Valor_nuevo: nuevo === null ? '' : nuevo
            });
          }
          var act = actividadPublica_(filaAObjeto_(fila, tabla.encabezados), hoy, config);
          return { id: id, ok: true, cambio: cambio, actividad: act };
        } catch (err) {
          if (!err.publico) throw err;
          return { id: id, ok: false, error: err.message, codigo: err.codigo };
        }
      });
    } finally {
      // Aunque algo falle a medias, lo que sí se escribió queda en la bitácora.
      agregarBitacora_(bitacora);
      SpreadsheetApp.flush();
    }

    var fallidos = resultados.filter(function (r) { return !r.ok; }).length;
    return { ok: fallidos === 0, guardados: resultados.length - fallidos, fallidos: fallidos, resultados: resultados,
             error: fallidos ? fallidos + ' registro(s) no se pudieron guardar.' : undefined };
  } finally {
    lock.releaseLock();
  }
}

/**
 * getResumenAdmin — todas las charlas + datos para el panel (solo admin).
 * Los totales se calculan en el navegador según los filtros elegidos;
 * aquí se marcan las charlas "atrasadas" (ya terminaron y no tienen asistencia).
 */
function getResumenAdmin(token) {
  verificarAdmin_(token);
  var config = leerConfig_();
  var hoy = infoHoy_(config);
  var acts = ordenarActividades_(leerActividades_(), config.dias);
  var salones = leerSalones_().map(function (s) {
    return { salon: s.salon, activo: s.activo, encargado: s.encargado,
             pinConfigurado: PINES_INVALIDOS.indexOf(texto_(s.pin).toUpperCase()) === -1 };
  });
  return {
    ok: true,
    evento: config.evento,
    dias: config.dias,
    bloqueo: config.bloqueo,
    hoy: hoy.dia,
    ahora: hoy.iso,
    referenciaFechas: hoy.referencia,
    urlHoja: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    salones: salones,
    actividades: acts.map(function (a) { return actividadPublica_(a, hoy, config); })
  };
}

/** getBitacora — últimos movimientos, del más reciente al más antiguo (solo admin). */
function getBitacora(token, limite) {
  verificarAdmin_(token);
  limite = Math.min(Math.max(parseInt(limite, 10) || 300, 1), 5000);
  var tabla = leerTabla_(HOJA_BITACORA, ['Fecha', 'Usuario', 'Salon', 'ID_actividad', 'Valor_anterior', 'Valor_nuevo']);
  var c = tabla.col;
  var filas = tabla.filas.filter(function (f) { return texto_(f[c.Fecha]) !== ''; });
  var ultimas = filas.slice(Math.max(0, filas.length - limite)).reverse();
  return {
    ok: true,
    total: filas.length,
    registros: ultimas.map(function (f) {
      var fecha = f[c.Fecha] instanceof Date ? f[c.Fecha] : null;
      return {
        fecha: fecha ? fecha.toISOString() : texto_(f[c.Fecha]),
        fechaTexto: fecha ? formatearFechaHora_(fecha) : texto_(f[c.Fecha]),
        usuario: texto_(f[c.Usuario]),
        salon: texto_(f[c.Salon]),
        id: texto_(f[c.ID_actividad]),
        anterior: texto_(f[c.Valor_anterior]),
        nuevo: texto_(f[c.Valor_nuevo])
      };
    })
  };
}

/** setBloqueo — activa (SI) o desactiva (NO) la edición para encargados (solo admin). */
function setBloqueo(valor, token) {
  verificarAdmin_(token);
  var nuevo = esSi_(valor) ? 'SI' : 'NO';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(ESPERA_LOCK_MS)) throw errorPublico_('El sistema está ocupado. Intente de nuevo.', 'OCUPADO');
  try {
    var hoja = obtenerHoja_(HOJA_CONFIG);
    var valores = hoja.getDataRange().getValues();
    var fila = -1;
    for (var i = 0; i < valores.length; i++) {
      if (mismoTexto_(valores[i][0], 'Bloquear_edicion')) { fila = i; break; }
    }
    var anterior = fila >= 0 ? (esSi_(valores[fila][1]) ? 'SI' : 'NO') : 'NO';
    if (fila >= 0) {
      hoja.getRange(fila + 1, 2).setValue(nuevo);
    } else {
      hoja.appendRow(['Bloquear_edicion', nuevo]);
    }
    if (anterior !== nuevo) {
      agregarBitacora_([{ Fecha: new Date(), Usuario: USUARIO_ADMIN, Salon: '—', ID_actividad: 'Bloquear_edicion',
                          Valor_anterior: anterior, Valor_nuevo: nuevo }]);
    }
    SpreadsheetApp.flush();
    return { ok: true, bloqueo: nuevo === 'SI' };
  } finally {
    lock.releaseLock();
  }
}


// ===========================================================================
//  AUTENTICACIÓN
// ===========================================================================

/**
 * Valida el PIN contra la hoja Salones / Config (siempre en el servidor).
 * Devuelve {rol: 'admin'|'encargado', salon, usuario}.
 */
function autenticarPin_(salon, pin) {
  var config = leerConfig_();
  var pinTxt = texto_(pin);
  var salonTxt = texto_(salon);
  var claveIntentos = 'fallos_' + normalizar_(salonTxt || 'admin');
  verificarIntentos_(claveIntentos);

  if (!pinTxt) throw errorPublico_('Ingrese el PIN.', 'PIN');

  var salonReal = null;
  var fichaSalon = null;
  if (salonTxt) {
    fichaSalon = leerSalones_().filter(function (s) { return mismoTexto_(s.salon, salonTxt); })[0];
    if (!fichaSalon) throw errorPublico_('El salón "' + salonTxt + '" no existe.', 'SALON');
    salonReal = fichaSalon.salon;
  }

  // 1) PIN de administrador: entra a cualquier salón.
  if (pinValido_(config.pinAdmin) && mismoPin_(pinTxt, config.pinAdmin)) {
    limpiarIntentos_(claveIntentos);
    return { rol: 'admin', salon: salonReal, usuario: USUARIO_ADMIN };
  }

  // 2) PIN del salón.
  if (fichaSalon) {
    if (!fichaSalon.activo) throw errorPublico_('El salón ' + salonReal + ' está desactivado.', 'SALON');
    if (!pinValido_(fichaSalon.pin)) {
      throw errorPublico_('El salón ' + salonReal + ' no tiene PIN configurado. Contacte al administrador.', 'PIN');
    }
    if (mismoPin_(pinTxt, fichaSalon.pin)) {
      limpiarIntentos_(claveIntentos);
      return { rol: 'encargado', salon: salonReal, usuario: salonReal };
    }
  }

  registrarFallo_(claveIntentos);
  throw errorPublico_(salonTxt ? 'PIN incorrecto para ' + salonReal + '.' : 'PIN de administrador incorrecto.', 'PIN');
}

/**
 * Token de sesión: "salon|rol|huellaPin|vence|firma".
 * La firma (HMAC-SHA256) usa un secreto guardado en las propiedades del
 * script, así que nadie puede fabricar un token. La "huella" del PIN hace
 * que, si usted cambia el PIN en la hoja, las sesiones viejas dejen de servir.
 */
function crearToken_(sesion) {
  var rol = sesion.rol;
  var salon = rol === 'admin' ? '' : sesion.salon;
  var vence = Date.now() + HORAS_SESION * 3600 * 1000;
  var datos = [encodeURIComponent(salon), rol, huellaPin_(pinActual_(rol, salon)), vence].join('|');
  return datos + '|' + firmar_(datos);
}

/** Verifica el token y devuelve {rol, salon, usuario}. */
function verificarToken_(token) {
  var partes = texto_(token).split('|');
  if (partes.length !== 5) throw errorPublico_('Sesión inválida. Vuelva a ingresar el PIN.', 'SESION');
  var datos = partes.slice(0, 4).join('|');
  if (firmar_(datos) !== partes[4]) throw errorPublico_('Sesión inválida. Vuelva a ingresar el PIN.', 'SESION');
  if (Number(partes[3]) < Date.now()) throw errorPublico_('La sesión venció. Vuelva a ingresar el PIN.', 'SESION');
  var rol = partes[1] === 'admin' ? 'admin' : 'encargado';
  var salon = decodeURIComponent(partes[0]);
  if (rol === 'encargado') {
    var ficha = leerSalones_().filter(function (s) { return mismoTexto_(s.salon, salon); })[0];
    if (!ficha || !ficha.activo) throw errorPublico_('El salón ' + salon + ' ya no está activo.', 'SESION');
    salon = ficha.salon;
  }
  var pin = pinActual_(rol, salon);
  if (!pinValido_(pin) || huellaPin_(pin) !== partes[2]) {
    throw errorPublico_('El PIN cambió. Vuelva a ingresarlo.', 'SESION');
  }
  return { rol: rol, salon: rol === 'admin' ? null : salon, usuario: rol === 'admin' ? USUARIO_ADMIN : salon };
}

/**
 * Sesión para leer o guardar asistencia:
 *  - con token → administrador (o encargado, si se usa un token de salón);
 *  - sin token → personal de apoyo, identificado por el nombre que escribió.
 */
function sesionDe_(token, usuario) {
  if (texto_(token)) return verificarToken_(token);
  var nombre = texto_(usuario).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').slice(0, 40);
  if (/^[=+\-@]/.test(nombre)) nombre = "'" + nombre; // evita fórmulas en la hoja
  return { rol: 'apoyo', salon: null, usuario: nombre };
}

function verificarAdmin_(token) {
  var s = verificarToken_(token);
  if (s.rol !== 'admin') throw errorPublico_('Solo el administrador puede hacer esto.', 'SESION');
  return s;
}

function pinActual_(rol, salon) {
  if (rol === 'admin') return leerConfig_().pinAdmin;
  var ficha = leerSalones_().filter(function (s) { return mismoTexto_(s.salon, salon); })[0];
  return ficha ? ficha.pin : '';
}

function huellaPin_(pin) {
  var p = texto_(pin);
  if (/^\d+$/.test(p)) p = String(parseInt(p, 10));
  return firmar_('pin:' + p).slice(0, 12);
}

function firmar_(txt) {
  var bytes = Utilities.computeHmacSha256Signature(txt, secreto_());
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

/** Secreto propio de este script (se crea solo la primera vez). */
function secreto_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('SECRETO_SESIONES');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SECRETO_SESIONES', s);
  }
  return s;
}

function pinValido_(pin) {
  return PINES_INVALIDOS.indexOf(texto_(pin).toUpperCase()) === -1;
}

/** Compara PINes. Si ambos son solo dígitos se comparan como número
 *  (Sheets a veces convierte "0123" en 123). */
function mismoPin_(a, b) {
  a = texto_(a); b = texto_(b);
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return parseInt(a, 10) === parseInt(b, 10);
  return a === b;
}

function verificarIntentos_(clave) {
  var n = parseInt(CacheService.getScriptCache().get(clave) || '0', 10);
  if (n >= MAX_INTENTOS_FALLIDOS) {
    throw errorPublico_('Demasiados intentos con PIN incorrecto. Espere 5 minutos.', 'PIN_BLOQUEADO');
  }
}
function registrarFallo_(clave) {
  var cache = CacheService.getScriptCache();
  var n = parseInt(cache.get(clave) || '0', 10) + 1;
  cache.put(clave, String(n), SEGUNDOS_BLOQUEO_PIN);
}
function limpiarIntentos_(clave) {
  CacheService.getScriptCache().remove(clave);
}


// ===========================================================================
//  LECTURA DE LA HOJA
// ===========================================================================

function obtenerHoja_(nombre) {
  var hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nombre);
  if (!hoja) throw errorPublico_('No se encontró la hoja "' + nombre + '" en la base de datos.', 'HOJA');
  return hoja;
}

/**
 * Lee una hoja completa. Ubica cada columna por su encabezado (fila 1),
 * sin importar el orden, las mayúsculas, tildes o espacios de más.
 * `requeridas`: columnas que deben existir (si falta alguna, error claro).
 */
function leerTabla_(nombre, requeridas) {
  var hoja = obtenerHoja_(nombre);
  var valores = hoja.getDataRange().getValues();
  var encabezados = (valores[0] || []).map(texto_);
  var col = {};
  (requeridas || []).forEach(function (req) {
    var idx = -1;
    for (var i = 0; i < encabezados.length; i++) {
      if (mismoTexto_(encabezados[i], req)) { idx = i; break; }
    }
    if (idx === -1) throw errorPublico_('Falta la columna "' + req + '" en la hoja ' + nombre + '.', 'COLUMNA');
    col[req] = idx;
  });
  return { hoja: hoja, encabezados: encabezados, col: col, filas: valores.slice(1) };
}

/** Convierte una fila en objeto usando los encabezados normalizados. */
function filaAObjeto_(fila, encabezados) {
  var o = {};
  encabezados.forEach(function (h, i) { if (h) o[normalizar_(h)] = fila[i]; });
  return {
    id: texto_(o.id).toUpperCase(),
    dia: texto_(o.dia),
    salon: texto_(o.salon),
    hora: texto_(o.hora).replace(/\s+/g, ' '),
    orden: Number(o.orden) || 0,
    entidad: texto_(o.entidad),
    simposio: texto_(o.simposio),
    charla: texto_(o.charla),
    expositor: texto_(o.expositor),
    codigo: texto_(o.codigo_medico),
    correo: texto_(o.correo),
    estado: texto_(o.estado).toUpperCase(),
    asistentes: numeroONulo_(o.asistentes),
    registradoPor: texto_(o.registrado_por),
    fechaRegistro: o.fecha_registro instanceof Date ? o.fecha_registro : null,
    notas: texto_(o.notas)
  };
}

/** Todas las actividades con ID (las filas vacías se ignoran). */
function leerActividades_() {
  var t = leerTabla_(HOJA_ACTIVIDADES, ['ID', 'Dia', 'Salon', 'Hora', 'Charla', 'Asistentes', 'Registrado_por', 'Fecha_registro']);
  return t.filas
    .map(function (f) { return filaAObjeto_(f, t.encabezados); })
    .filter(function (a) { return a.id; });
}

function leerSalones_() {
  var t = leerTabla_(HOJA_SALONES, ['Salon', 'PIN_encargado']);
  return t.filas.map(function (f) { return filaAObjeto2_(f, t.encabezados); })
    .filter(function (o) { return texto_(o.salon); })
    .map(function (o) {
      return {
        salon: texto_(o.salon),
        pin: texto_(o.pin_encargado),
        encargado: texto_(o.encargado),
        // Si no existe la columna Activo, el salón se considera activo.
        activo: o.activo === undefined || texto_(o.activo) === '' || esSi_(o.activo)
      };
    });
}

function filaAObjeto2_(fila, encabezados) {
  var o = {};
  encabezados.forEach(function (h, i) { if (h) o[normalizar_(h)] = fila[i]; });
  return o;
}

/**
 * Hoja Config en formato Clave | Valor. Claves reconocidas:
 *  PIN_admin, Evento, Dias, Bloquear_edicion y (opcional) Fecha_inicio,
 *  la fecha del primer día del congreso, usada para saber qué día es "hoy"
 *  y qué charlas ya pasaron. Si no existe, se usa la semana actual.
 */
function leerConfig_() {
  var valores = obtenerHoja_(HOJA_CONFIG).getDataRange().getValues();
  var mapa = {};
  valores.forEach(function (f) { if (texto_(f[0])) mapa[normalizar_(f[0])] = f[1]; });
  var dias = texto_(mapa.dias || 'Lunes,Martes,Miércoles,Jueves,Viernes')
    .split(/[,;]/).map(function (d) { return d.trim(); }).filter(String);
  var fechaInicio = mapa.fecha_inicio instanceof Date ? mapa.fecha_inicio : parsearFecha_(texto_(mapa.fecha_inicio));
  return {
    pinAdmin: texto_(mapa.pin_admin),
    evento: texto_(mapa.evento) || 'Congreso',
    dias: dias,
    bloqueo: esSi_(mapa.bloquear_edicion),
    fechaInicio: fechaInicio
  };
}

/** Agrega filas a la Bitacora respetando el orden de sus columnas. */
function agregarBitacora_(registros) {
  if (!registros.length) return;
  var t = leerTabla_(HOJA_BITACORA, ['Fecha', 'Usuario', 'Salon', 'ID_actividad', 'Valor_anterior', 'Valor_nuevo']);
  var ancho = t.encabezados.length;
  var filas = registros.map(function (r) {
    var fila = [];
    for (var i = 0; i < ancho; i++) fila.push('');
    Object.keys(t.col).forEach(function (k) { fila[t.col[k]] = r[k]; });
    return fila;
  });
  var hoja = t.hoja;
  hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, ancho).setValues(filas);
}


// ===========================================================================
//  HORAS, DÍAS Y ORDEN
// ===========================================================================

/**
 * Interpreta textos de hora como los del programa:
 *   "1:30 - 1:50 p.m."  "9:00 - 12:00 p.m."  "10:10 a.m. – 10:40 a.m."
 *   "3:30 -- 3:50 p.m." "9:00 - 9:20 am"     "1:30 p.m. - 2:20 p.m"
 * Devuelve {inicio, fin} en minutos desde medianoche (o null si no se entiende).
 */
function parsearHora_(txt) {
  var s = texto_(txt).toLowerCase()
    .replace(/[–—]/g, '-').replace(/-+/g, '-')
    .replace(/a\.?\s*m\.?/g, 'am').replace(/p\.?\s*m\.?/g, 'pm');
  var partes = s.split('-');
  var re = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/;
  var a = re.exec(partes[0] || '');
  var b = partes.length > 1 ? re.exec(partes[1]) : null;
  if (!a) return { inicio: null, fin: null };

  function aMin(h, m, suf) {
    h = parseInt(h, 10); m = parseInt(m || '0', 10);
    if (!suf) suf = (h >= 7 && h <= 11) ? 'am' : 'pm'; // adivinanza razonable
    if (suf === 'am' && h === 12) h = 0;
    if (suf === 'pm' && h !== 12) h += 12;
    return h * 60 + m;
  }
  var sufB = b ? (b[3] || a[3]) : null;
  var fin = b ? aMin(b[1], b[2], sufB) : null;
  var inicio;
  if (a[3]) {
    inicio = aMin(a[1], a[2], a[3]);
  } else if (sufB) {
    inicio = aMin(a[1], a[2], sufB);
    // "9:00 - 12:00 p.m." → el inicio es a.m.
    if (fin !== null && inicio > fin) inicio = aMin(a[1], a[2], 'am');
  } else {
    inicio = aMin(a[1], a[2], null);
  }
  return { inicio: inicio, fin: fin };
}

/** Ordena por día (según Config), salón, hora de inicio y Orden. */
function ordenarActividades_(acts, dias) {
  dias = dias || [];
  function idxDia(d) {
    for (var i = 0; i < dias.length; i++) if (mismoTexto_(dias[i], d)) return i;
    return 99;
  }
  return acts.map(function (a) { a._h = parsearHora_(a.hora); return a; }).sort(function (x, y) {
    return (idxDia(x.dia) - idxDia(y.dia)) ||
      x.salon.localeCompare(y.salon) ||
      ((x._h.inicio === null ? 9999 : x._h.inicio) - (y._h.inicio === null ? 9999 : y._h.inicio)) ||
      (x.orden - y.orden);
  });
}

/** Zona horaria de la hoja (las celdas de fecha se interpretan en ella). */
function zonaHoja_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || ZONA_HORARIA;
}

/** Momento actual en Costa Rica. */
function ahora_() {
  var d = new Date();
  var f = Utilities.formatDate(d, ZONA_HORARIA, 'yyyy-MM-dd HH:mm u');
  var p = f.split(' ');
  var hm = p[1].split(':');
  return {
    iso: d.toISOString(),
    fecha: p[0],                                       // "2026-11-10"
    minutos: parseInt(hm[0], 10) * 60 + parseInt(hm[1], 10),
    diaSemana: parseInt(p[2], 10) % 7                  // 0 = domingo
  };
}

/**
 * Qué día del congreso es hoy y la fecha real de cada día.
 *  - Con Config → Fecha_inicio: cada día de la lista "Dias" corresponde a la
 *    primera fecha, a partir de Fecha_inicio, cuyo nombre de día coincide.
 *  - Sin Fecha_inicio: se asume que el congreso es la semana actual.
 */
function infoHoy_(config) {
  var ahora = ahora_();
  var fechas = {};
  var base;
  if (config.fechaInicio) {
    base = Utilities.formatDate(config.fechaInicio, zonaHoja_(), 'yyyy-MM-dd');
  } else {
    // Lunes de la semana actual.
    var dLunes = (ahora.diaSemana + 6) % 7;
    base = sumarDias_(ahora.fecha, -dLunes);
  }
  var cursor = base;
  config.dias.forEach(function (d) {
    for (var i = 0; i < 7; i++) {
      var f = sumarDias_(cursor, i);
      if (mismoTexto_(NOMBRES_DIAS[diaSemanaDe_(f)], d)) { fechas[normalizar_(d)] = f; cursor = sumarDias_(f, 1); return; }
    }
  });
  var diaHoy = null;
  config.dias.forEach(function (d) { if (fechas[normalizar_(d)] === ahora.fecha) diaHoy = d; });
  return {
    dia: diaHoy,
    fecha: ahora.fecha,
    minutos: ahora.minutos,
    iso: ahora.iso,
    fechas: fechas,
    referencia: config.fechaInicio ? 'Fecha_inicio' : 'semana actual'
  };
}

/** true si la charla ya terminó y no tiene asistencia registrada. */
function estaAtrasada_(a, hoy) {
  if (a.asistentes !== null) return false;
  var fecha = hoy.fechas[normalizar_(a.dia)];
  if (!fecha) return false;
  if (fecha < hoy.fecha) return true;
  if (fecha > hoy.fecha) return false;
  var h = a._h || parsearHora_(a.hora);
  var fin = h.fin !== null ? h.fin : (h.inicio !== null ? h.inicio + 20 : null);
  return fin !== null && fin <= hoy.minutos;
}

function sumarDias_(fechaIso, n) {
  var p = fechaIso.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return d.toISOString().slice(0, 10);
}
function diaSemanaDe_(fechaIso) {
  var p = fechaIso.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
}
/** Acepta "2026-11-09" o "9/11/2026" (día/mes/año). */
function parsearFecha_(s) {
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], 12);
  return null;
}


// ===========================================================================
//  FORMATO DE SALIDA
// ===========================================================================

/** Lo que el navegador recibe de cada actividad (nunca PINes). */
function actividadPublica_(a, hoy, config) {
  var h = a._h || parsearHora_(a.hora);
  return {
    id: a.id,
    dia: a.dia,
    salon: a.salon,
    hora: a.hora,
    inicio: h.inicio,
    fin: h.fin,
    orden: a.orden,
    entidad: a.entidad,
    simposio: a.simposio,
    charla: a.charla,
    expositores: separarExpositores_(a.expositor, a.codigo, a.correo),
    expositor: a.expositor,
    codigo: a.codigo,
    correo: a.correo,
    estado: a.estado === 'PENDIENTE' ? 'PENDIENTE' : (a.estado || 'CONFIRMADO'),
    asistentes: a.asistentes,
    registradoPor: a.registradoPor,
    fechaRegistro: a.fechaRegistro ? a.fechaRegistro.toISOString() : null,
    horaRegistro: a.fechaRegistro ? formatearHora_(a.fechaRegistro) : '',
    atrasada: estaAtrasada_(a, hoy)
  };
}

/**
 * Separa "A / B" en expositor, código y correo.
 * Si la cantidad de códigos o correos coincide con la de expositores, se
 * emparejan por posición. Si no coincide (datos incompletos), no se adivina:
 * se devuelven aparte en `correosSueltos` / `codigosSueltos`.
 */
function separarExpositores_(expositor, codigo, correo) {
  function lista(s) { return texto_(s).split(/\s+\/\s+|\s*\/\s*/).map(function (x) { return x.trim(); }).filter(String); }
  var nombres = lista(expositor);
  var codigos = lista(codigo);
  var correos = lista(correo);
  var codOk = codigos.length === nombres.length;
  var corOk = correos.length === nombres.length;
  return {
    personas: nombres.map(function (n, i) {
      var vacio = function (x) { return /^[—–-]$/.test(x || '') ? '' : (x || ''); };
      return { nombre: n, codigo: codOk ? vacio(codigos[i]) : '', correo: corOk ? vacio(correos[i]) : '' };
    }),
    codigosSueltos: codOk ? [] : codigos,
    correosSueltos: corOk ? [] : correos
  };
}

/** "10:42 a.m." */
function formatearHora_(d) {
  var t = Utilities.formatDate(d, ZONA_HORARIA, 'h:mm a');
  return t.replace(/AM$/i, 'a.m.').replace(/PM$/i, 'p.m.');
}
/** "10/11/2026 10:42 a.m." */
function formatearFechaHora_(d) {
  return Utilities.formatDate(d, ZONA_HORARIA, 'dd/MM/yyyy') + ' ' + formatearHora_(d);
}


// ===========================================================================
//  UTILIDADES
// ===========================================================================

function texto_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

/** Minúsculas, sin tildes y sin espacios extra: "Miércoles " → "miercoles". */
function normalizar_(v) {
  return texto_(v).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
}
function mismoTexto_(a, b) { return normalizar_(a) === normalizar_(b); }

function esSi_(v) {
  if (v === true) return true;
  var t = normalizar_(v);
  return t === 'si' || t === 'true' || t === 'verdadero' || t === '1' || t === 'x';
}

/** Número entero guardado en la hoja, o null si la celda está vacía. */
function numeroONulo_(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

/** Valida el valor recibido: entero ≥ 0 (o vacío para borrar, solo admin). */
function validarValor_(v, permiteVacio) {
  var t = texto_(v);
  if (t === '') {
    if (permiteVacio) return null;
    throw errorPublico_('Escriba la cantidad de asistentes.', 'VALOR');
  }
  if (!/^\d+$/.test(t)) throw errorPublico_('La cantidad debe ser un número entero de 0 en adelante.', 'VALOR');
  var n = parseInt(t, 10);
  if (n > 100000) throw errorPublico_('La cantidad parece demasiado grande.', 'VALOR');
  return n;
}

function errorPublico_(mensaje, codigo) {
  var e = new Error(mensaje);
  e.publico = true;
  e.codigo = codigo || 'ERROR';
  return e;
}


// ===========================================================================
//  PRUEBA MANUAL DESDE EL EDITOR (opcional)
// ===========================================================================

/**
 * Ejecute esta función desde el editor de Apps Script (botón ▶) para ver en
 * el registro de ejecución si el script lee bien la hoja. No modifica nada.
 */
function probarLectura() {
  var r = getSalones();
  Logger.log('Evento: ' + r.evento + ' | Hoy: ' + r.hoy + ' | Bloqueo: ' + r.bloqueo);
  r.salones.forEach(function (s) {
    Logger.log(s.salon + ': ' + s.registradas + '/' + s.total + ' — días: ' + s.dias.join(', '));
  });
}
