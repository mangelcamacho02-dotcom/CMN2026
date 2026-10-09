/* =========================================================================
   ⚠ ESTE ARCHIVO NO VA EN APPS SCRIPT. Va en GitHub, junto a index.html.
     En Apps Script se pega únicamente Code.gs.
   =========================================================================
   CMN 2026 — Registro de asistencia por charla (frontend)
   Pantalla principal con los salones (carrusel) → pantalla de cada salón
   con sus días y charlas en filas. Lo usa el personal de apoyo (sin PIN).
   El panel de administración sí pide el PIN de administrador.
   HTML + CSS + JavaScript puro. Todos los datos vienen de la hoja de Google
   a través del Apps Script publicado como aplicación web.
   ========================================================================= */

// URL de la aplicación web de Apps Script (termina en /exec).
// Es lo ÚNICO que hay que cambiar en este archivo.
const API_URL = 'https://script.google.com/macros/s/AKfycbwO7EsIIo6AlRPD4Kwn1CTui--G04Trrb4LD0yQzVtq099P7RsNBii5UB_v6mSBplOJ/exec';

const REFRESCO_MS = 60 * 1000;   // los datos se actualizan solos cada 60 s
const TIMEOUT_MS = 30 * 1000;    // tiempo máximo de espera por respuesta
const CLAVE_SESION = 'cmn2026_sesion';
const CLAVE_NOMBRE = 'cmn2026_nombre';
const CLAVE_ULTIMO = 'cmn2026_ultimo_salon';
const ZONA = 'America/Costa_Rica';

// ---------------------------------------------------------------------------
//  Estado de la aplicación
// ---------------------------------------------------------------------------
const estado = {
  datos: null,             // respuesta de getTodo (todas las charlas)
  firma: '',               // para saber si algo cambió al refrescar
  dia: null,               // día seleccionado
  salon: null,             // salón seleccionado
  borradores: new Map(),   // id → texto escrito y no guardado
  errores: new Map(),      // id → mensaje de error del último intento
  guardando: new Set(),    // ids que se están guardando
  renderPendiente: false,  // llegaron datos nuevos mientras alguien escribía
  ultimaCarga: 0,
  avisoNombre: false,
  admin: null,             // respuesta de getResumenAdmin
  admTab: 'totales',
  bitacora: null,
  vista: null
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
//  Utilidades
// ---------------------------------------------------------------------------
function norm(t) {
  return String(t == null ? '' : t).trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
}
function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function minAHora(m) {
  if (m == null) return '';
  let h = Math.floor(m / 60); const mm = String(m % 60).padStart(2, '0');
  const suf = h >= 12 ? 'p.m.' : 'a.m.';
  h = h % 12 || 12;
  return `${h}:${mm} ${suf}`;
}
function fechaHora(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const f = d.toLocaleDateString('es-CR', { timeZone: ZONA, day: '2-digit', month: '2-digit' });
    const h = d.toLocaleTimeString('es-CR', { timeZone: ZONA, hour: 'numeric', minute: '2-digit', hour12: true });
    return `${f} ${h}`;
  } catch (e) { return iso; }
}
function horaActual() {
  return new Date().toLocaleTimeString('es-CR', { timeZone: ZONA, hour: 'numeric', minute: '2-digit', hour12: true });
}
/** Minutos desde medianoche, hora de Costa Rica. */
function minutosAhora() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date());
  const h = Number(p.find((x) => x.type === 'hour').value) % 24;
  return h * 60 + Number(p.find((x) => x.type === 'minute').value);
}
function errorApp(mensaje, codigo) { const e = new Error(mensaje); e.codigo = codigo || 'ERROR'; return e; }
function leerLocal(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
function guardarLocal(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* modo privado */ } }
const punteroFino = () => window.matchMedia && window.matchMedia('(pointer: fine)').matches;

let toastTimer = null;
function toast(msg, tipo) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (tipo ? ' ' + tipo : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, tipo === 'err' ? 6000 : 3000);
}

// ---------------------------------------------------------------------------
//  Sesión de administrador (sessionStorage: dura mientras la pestaña esté abierta)
// ---------------------------------------------------------------------------
const Sesion = {
  _memoria: null,
  admin() {
    try { const s = JSON.parse(sessionStorage.getItem(CLAVE_SESION) || 'null'); return s && s.admin ? s.admin : null; } catch (e) { return this._memoria; }
  },
  guardarLogin(r) {
    this._memoria = { token: r.token };
    try { sessionStorage.setItem(CLAVE_SESION, JSON.stringify({ admin: this._memoria })); } catch (e) { /* modo privado */ }
  },
  olvidarToken() {
    this._memoria = null;
    try { sessionStorage.removeItem(CLAVE_SESION); } catch (e) { /* modo privado */ }
  }
};

/** Nombre de quien registra (se recuerda en esta computadora). */
function nombreUsuario() { return $('inpNombre').value.trim(); }

// ---------------------------------------------------------------------------
//  Comunicación con el Apps Script
// ---------------------------------------------------------------------------
function apiConfigurada() { return /^https:\/\//.test(API_URL); }

/**
 * Llama a la API. Se envía como text/plain para evitar el "preflight" CORS
 * (Apps Script no lo acepta). Devuelve el JSON tal cual ({ok, ...}).
 * Lanza error solo si no hubo respuesta válida (red, tiempo, URL mala).
 */
async function api(accion, datos) {
  if (!apiConfigurada()) throw errorApp('Falta configurar la URL del Apps Script (API_URL en app.js).', 'CONFIG');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ accion }, datos || {})),
      signal: ctrl.signal,
      redirect: 'follow'
    });
  } catch (e) {
    throw errorApp(e.name === 'AbortError'
      ? 'El servidor tardó demasiado. Revise la conexión e intente de nuevo.'
      : 'Sin conexión con el servidor. Revise la conexión e intente de nuevo.', 'RED');
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw errorApp('El servidor respondió con un error (' + resp.status + '). Intente de nuevo.', 'RED');
  let json;
  try { json = await resp.json(); } catch (e) {
    throw errorApp('Respuesta inesperada del servidor. Verifique que la app web esté publicada con acceso "Cualquier persona".', 'RED');
  }
  if (json && json.codigo === 'SESION' && datos && datos.token) {
    Sesion.olvidarToken();
    setTimeout(() => { toast(json.error, 'err'); ruta(); }, 0);
  }
  return json;
}

/** Igual que api() pero lanza error si la respuesta trae ok:false. */
async function apiOk(accion, datos) {
  const r = await api(accion, datos);
  if (r && !r.ok && /^Acción desconocida/.test(r.error || '')) {
    throw errorApp('El Apps Script publicado es una versión vieja. Pegue el Code.gs actual en Apps Script y publique ' +
      '"Nueva versión" (Implementar → Gestionar implementaciones → ✏ → Nueva versión).', 'VERSION');
  }
  if (!r || !r.ok) throw errorApp((r && r.error) || 'Error desconocido.', r && r.codigo);
  return r;
}

// ---------------------------------------------------------------------------
//  Navegación (#/  ·  #/s/Real%201/Martes  ·  #/admin)
// ---------------------------------------------------------------------------
function ir(hash) {
  if (location.hash === hash) ruta(); else location.hash = hash;
}
function hashSalon(salon, dia) {
  return '#/s/' + encodeURIComponent(salon || '') + (dia ? '/' + encodeURIComponent(dia) : '');
}
function fijarHash() { history.replaceState(null, '', hashSalon(estado.salon, estado.dia)); }

function ruta() {
  const partes = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (partes[0] === 'admin') return mostrarAdmin();
  if ((partes[0] === 's' || partes[0] === 'salon') && partes[1]) return mostrarSalon(partes[1], partes[2]);
  return mostrarInicio();
}

/** Muestra una pantalla y ajusta el encabezado (grande en la principal, compacto en las demás). */
function mostrarVista(id, titulo, subtitulo) {
  estado.vista = id;
  ['vInicio', 'vSalon', 'vPin', 'vAdmin'].forEach((v) => { $(v).hidden = v !== id; });
  $('top').classList.toggle('compacto', id !== 'vInicio');
  $('top').classList.toggle('ancho', id === 'vAdmin' || id === 'vSalon');
  $('app').classList.toggle('ancho', id === 'vAdmin' || id === 'vSalon');
  $('kicker').textContent = (estado.datos && estado.datos.evento) || 'Congreso Médico Nacional 2026';
  $('tituloEvento').textContent = titulo || 'Asistencia';
  $('subtitulo').innerHTML = subtitulo || '';
  if (id !== 'vInicio') $('chips').innerHTML = '';
  $('btnVolver').hidden = id === 'vInicio';
  $('barraGuardarTodo').hidden = id !== 'vSalon';
  mostrarError('errorGeneral', '');
  document.title = (titulo ? titulo + ' · ' : '') + 'Asistencia CMN 2026';
}
function cargando(si) { $('cargando').hidden = !si; }
function mostrarError(id, msg) { const el = $(id); el.textContent = msg || ''; el.hidden = !msg; }

/** ¿Hay alguien escribiendo en un campo de asistentes? */
function escribiendo() {
  const a = document.activeElement;
  return !!(a && a.tagName === 'INPUT' && (a.dataset.id || a.dataset.aid));
}

// ---------------------------------------------------------------------------
//  Datos (una sola petición trae todas las charlas)
// ---------------------------------------------------------------------------
async function cargarDatos(silencioso) {
  try {
    const r = await apiOk('getTodo');
    estado.datos = r;
    estado.ultimaCarga = Date.now();
    $('actualizado').textContent = horaActual();
    $('kicker').textContent = r.evento;
    const firma = JSON.stringify([r.actividades, r.bloqueo, r.dias, r.salones]);
    const cambio = firma !== estado.firma;
    estado.firma = firma;
    renderAvisos();
    if (estado.vista === 'vInicio') { renderInicio(); return; }
    if (estado.vista !== 'vSalon') return;
    elegirDiaDelSalon();
    if (silencioso && !cambio) { renderDias(); parchearTabla(); return; }  // refresca "en curso" / "ya terminó"
    if (silencioso) {
      renderDias();
      if (!parchearTabla()) {
        if (escribiendo()) estado.renderPendiente = true; else renderTabla();
      }
      actualizarResumen();
      return;
    }
    renderSalon();
  } catch (e) {
    if (silencioso) $('actualizado').textContent = 'sin conexión';
    else mostrarError('errorGeneral', e.message);
  } finally {
    cargando(false);
  }
}

function actsDe(salon, dia) {
  if (!estado.datos) return [];
  return estado.datos.actividades.filter((a) => norm(a.salon) === norm(salon) && (dia == null || norm(a.dia) === norm(dia)));
}
function actividad(id) { return estado.datos && estado.datos.actividades.find((a) => a.id === id); }
function puedeGuardar() { return !!estado.datos && !estado.datos.bloqueo; }

/** ¿Ya terminó y no tiene asistencia? (en vivo para el día de hoy) */
function yaTermino(a) {
  if (a.asistentes != null) return false;
  if (a.atrasada) return true;
  const r = estado.datos;
  return norm(a.dia) === norm(r.hoy) && a.fin != null && a.fin <= minutosAhora();
}
function enCurso(a) {
  const r = estado.datos;
  if (norm(a.dia) !== norm(r.hoy) || a.inicio == null) return false;
  const m = minutosAhora();
  return a.inicio <= m && m < (a.fin != null ? a.fin : a.inicio + 20);
}

function renderAvisos() {
  $('avisoBloqueo').hidden = !(estado.datos && estado.datos.bloqueo);
}

// ---------------------------------------------------------------------------
//  Pantalla principal: salones en carrusel
// ---------------------------------------------------------------------------
async function mostrarInicio() {
  mostrarVista('vInicio', null, 'Registro de asistentes por charla. Elija el salón y anote cuántas personas hubo en cada charla.');
  if (estado.datos) renderInicio(); else cargando(true);
  await cargarDatos(false);
}

function renderInicio() {
  const r = estado.datos;
  if (!r) return;
  const total = r.actividades.length;
  const reg = r.actividades.filter((a) => a.asistentes != null).length;
  $('chips').innerHTML = [`<b>${r.salones.length}</b> salones`, `<b>${total}</b> charlas`, `<b>${reg}</b> registradas`,
    r.hoy ? `Hoy: <b>${esc(r.hoy)}</b>` : `<b>${r.dias.length}</b> días`]
    .map((x) => `<span class="chip">${x}</span>`).join('');
  const pista = $('gridSalones');
  const posicion = pista.scrollLeft; // al refrescar no se pierde el lugar del carrusel
  pista.innerHTML = r.salones.length ? r.salones.map((s, i) => {
    const acts = actsDe(s.salon);
    const n = acts.filter((a) => a.asistentes != null).length;
    const atr = acts.filter(yaTermino).length;
    const hoyActs = r.hoy ? actsDe(s.salon, r.hoy) : [];
    const pct = acts.length ? Math.round((n / acts.length) * 100) : 0;
    const dias = r.dias.map((d) => {
      const tiene = acts.some((a) => norm(a.dia) === norm(d));
      const cls = !tiene ? 'no' : (norm(d) === norm(r.hoy) ? 'hoy' : '');
      return `<span class="${cls}" title="${esc(d)}${tiene ? '' : ': sin charlas'}">${esc(String(d).slice(0, 3))}</span>`;
    }).join('');
    return `<button type="button" class="tarjeta-salon${acts.length && pct === 100 ? ' completo' : ''}" data-salon="${esc(s.salon)}"
        aria-roledescription="diapositiva" aria-label="${esc(s.salon)}, ${i + 1} de ${r.salones.length}">
        <span class="ph"><small>Salón</small><span class="nombre">${esc(s.salon)}</span><span class="pct">${pct}%</span></span>
        <span class="bd">
          <span class="avance">${n} / ${acts.length} charlas registradas</span>
          <span class="bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
          <span class="dias-mini" aria-hidden="true">${dias}</span>
          ${atr ? `<span class="m-atr">${atr} atrasada${atr === 1 ? '' : 's'}</span>` : ''}
          <span class="entrar">${hoyActs.length ? `Hoy: ${hoyActs.length} charla${hoyActs.length === 1 ? '' : 's'} · ` : ''}Entrar →</span>
        </span>
      </button>`;
  }).join('') : '<p class="vacio">No hay salones activos en la hoja "Salones".</p>';
  $('carNav').hidden = r.salones.length < 2;
  $('carPuntos').innerHTML = r.salones.map((s, i) =>
    `<button type="button" class="car-punto" data-i="${i}" aria-label="Ir a ${esc(s.salon)}"></button>`).join('');
  if (!carrusel.iniciado) {
    // Primera vez: mostrar el último salón usado.
    carrusel.iniciado = true;
    const ult = leerLocal(CLAVE_ULTIMO);
    const i = r.salones.findIndex((s) => norm(s.salon) === norm(ult));
    if (i > 0) requestAnimationFrame(() => carrusel.ir(i, false));
  } else {
    pista.style.scrollBehavior = 'auto';
    pista.scrollLeft = posicion;
    pista.style.scrollBehavior = '';
  }
  carrusel.actualizar();
}

const carrusel = {
  iniciado: false,
  tarjetas() { return [...$('gridSalones').querySelectorAll('.tarjeta-salon')]; },
  /** Índice de la primera tarjeta visible. */
  actual() {
    const pista = $('gridSalones');
    const ts = this.tarjetas();
    if (!ts.length) return 0;
    const base = ts[0].offsetLeft;
    let mejor = 0;
    ts.forEach((t, i) => {
      if (Math.abs(t.offsetLeft - base - pista.scrollLeft) < Math.abs(ts[mejor].offsetLeft - base - pista.scrollLeft)) mejor = i;
    });
    return mejor;
  },
  /** Cuántas tarjetas caben completas en pantalla. */
  visibles() {
    const ts = this.tarjetas();
    if (ts.length < 2) return 1;
    const paso = ts[1].offsetLeft - ts[0].offsetLeft;
    return Math.max(1, Math.floor(($('gridSalones').clientWidth - 16) / paso));
  },
  ir(i, suave) {
    const ts = this.tarjetas();
    if (!ts.length) return;
    i = Math.max(0, Math.min(i, ts.length - 1));
    $('gridSalones').scrollTo({ left: ts[i].offsetLeft - ts[0].offsetLeft, behavior: suave === false ? 'auto' : 'smooth' });
  },
  mover(dir) { this.ir(this.actual() + dir * this.visibles()); },
  actualizar() {
    const pista = $('gridSalones');
    const ts = this.tarjetas();
    const i = this.actual();
    const v = this.visibles();
    document.querySelectorAll('#carPuntos .car-punto').forEach((p, k) => p.setAttribute('aria-current', String(k >= i && k < i + v)));
    $('carPrev').disabled = pista.scrollLeft < 4;
    $('carNext').disabled = pista.scrollLeft + pista.clientWidth >= pista.scrollWidth - 4 || ts.length < 2;
  }
};

// ---------------------------------------------------------------------------
//  Pantalla del salón: días y charlas
// ---------------------------------------------------------------------------
async function mostrarSalon(salon, dia) {
  if (norm(salon) !== norm(estado.salon)) estado.dia = null;
  estado.salon = salon;
  if (dia) estado.dia = dia;
  guardarLocal(CLAVE_ULTIMO, salon);
  mostrarVista('vSalon', salon, '');
  if (estado.datos) { elegirDiaDelSalon(); renderSalon(); enfocarPrimeraVacia(); } else { $('tabla').innerHTML = ''; cargando(true); }
  const primeraVez = !estado.datos;
  await cargarDatos(false);
  if (primeraVez) enfocarPrimeraVacia();
}

/** Día del salón: el elegido, si no hoy, si no el primero con charlas. */
function elegirDiaDelSalon() {
  const r = estado.datos;
  const real = r.salones.find((s) => norm(s.salon) === norm(estado.salon));
  if (real) estado.salon = real.salon;
  const conCharlas = r.dias.filter((d) => actsDe(estado.salon, d).length);
  estado.dia = conCharlas.find((d) => norm(d) === norm(estado.dia)) ||
    conCharlas.find((d) => norm(d) === norm(r.hoy)) || conCharlas[0] || r.dias[0] || null;
}

function renderSalon() {
  const r = estado.datos;
  const existe = r.salones.some((s) => norm(s.salon) === norm(estado.salon));
  $('tituloEvento').textContent = estado.salon;
  $('subtitulo').innerHTML = existe
    ? `${esc(estado.dia || '')}${norm(estado.dia) === norm(r.hoy) ? ' <b class="hoy">· hoy</b>' : ''} — escriba el número y presione <b>Enter</b> para guardar.`
    : 'Este salón no existe o está desactivado en la hoja "Salones".';
  renderDias();
  renderTabla();
}

/** Pestañas de días del salón: registradas/total y burbuja de cambios sin guardar. */
function renderDias() {
  const r = estado.datos;
  $('tabsDias').innerHTML = r.dias.map((d) => {
    const acts = actsDe(estado.salon, d);
    const reg = acts.filter((a) => a.asistentes != null).length;
    const pend = acts.filter((a) => estado.borradores.has(a.id)).length;
    const sel = norm(d) === norm(estado.dia);
    const hoy = norm(d) === norm(r.hoy);
    return `<button type="button" class="tab-dia" role="tab" data-dia="${esc(d)}" aria-selected="${sel}" ${acts.length ? '' : 'disabled'}
      title="${esc(d)}${acts.length ? `: ${reg} de ${acts.length} charlas registradas` : ' (sin charlas)'}">
      ${pend ? `<span class="bdg" title="Cambios sin guardar">${pend}</span>` : ''}
      <b>${esc(d)}</b><small>${hoy ? '<span class="hoy">Hoy · </span>' : ''}${acts.length ? `${reg} de ${acts.length}` : 'sin charlas'}</small></button>`;
  }).join('');
}

/** Agrupa charlas consecutivas del mismo Simposio + Entidad. */
function agruparBloques(acts) {
  const bloques = [];
  acts.forEach((a) => {
    const clave = norm(a.simposio) + '|' + norm(a.entidad);
    let b = bloques[bloques.length - 1];
    if (!b || b.clave !== clave) { b = { clave, simposio: a.simposio, entidad: a.entidad, acts: [] }; bloques.push(b); }
    b.acts.push(a);
  });
  bloques.forEach((b) => {
    const ini = b.acts.map((a) => a.inicio).filter((x) => x != null);
    const fin = b.acts.map((a) => (a.fin != null ? a.fin : a.inicio)).filter((x) => x != null);
    b.rango = ini.length ? minAHora(Math.min(...ini)) + ' – ' + minAHora(Math.max(...fin)) : '';
  });
  return bloques;
}

function firmaTabla(acts) {
  return JSON.stringify(acts.map((a) => [a.id, a.hora, a.charla, a.expositor, a.codigo, a.correo, a.estado, a.simposio, a.entidad]));
}

/** Tabla de charlas del salón y día elegidos. */
function renderTabla() {
  estado.renderPendiente = false;
  const r = estado.datos;
  if (!r) return;
  const acts = actsDe(estado.salon, estado.dia);
  estado.firmaTabla = firmaTabla(acts);
  const foco = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : null;
  if (!acts.length) {
    $('tabla').innerHTML = `<p class="vacio">${esc(estado.salon || '')} no tiene charlas el ${esc((estado.dia || '').toLowerCase())}.</p>`;
  } else {
    $('tabla').innerHTML = agruparBloques(acts).map((b) => {
      const regB = b.acts.filter((a) => a.asistentes != null).length;
      return `<section class="bloque">
        <header class="bloque-cab">
          <div class="b-txt"><h3>${esc(b.simposio || 'Sin simposio')}</h3>${b.entidad ? `<span class="entidad">${esc(b.entidad)}</span>` : ''}</div>
          <div class="b-meta">${b.rango ? `<span class="rango">${esc(b.rango)}</span>` : ''}<span class="b-cuenta">${regB}/${b.acts.length}</span></div>
        </header>
        <div class="filas">${b.acts.map(htmlFila).join('')}</div>
      </section>`;
    }).join('');
  }
  if (foco) {
    const inp = document.querySelector(`#tabla input[data-id="${CSS.escape(foco)}"]`);
    if (inp) inp.focus({ preventScroll: true });
  }
  actualizarResumen();
}

/** Si solo cambiaron números/estados (no la estructura), actualiza fila por fila. */
function parchearTabla() {
  const acts = actsDe(estado.salon, estado.dia);
  if (firmaTabla(acts) !== estado.firmaTabla) return false;
  acts.forEach((a) => actualizarFila(a.id));
  return true;
}

function htmlExpositores(a) {
  const e = a.expositores || { personas: [], codigosSueltos: [], correosSueltos: [] };
  const sinNombre = !e.personas.length || (e.personas.length === 1 && norm(e.personas[0].nombre) === 'pendiente');
  if (sinNombre) return '<div class="exp"><span class="exp-nombre">Expositor por confirmar</span></div>';
  const lineas = e.personas.map((p) => {
    const cod = p.codigo ? (/^\d+$/.test(p.codigo) ? 'Cód. ' + p.codigo : p.codigo) : 'Cód. —';
    return `<div class="exp"><span class="exp-nombre">${esc(p.nombre)}</span>
      <span class="exp-datos">${esc(cod)} · ${p.correo ? `<a href="mailto:${esc(p.correo)}">${esc(p.correo)}</a>` : '—'}</span></div>`;
  });
  if (e.codigosSueltos.length) lineas.push(`<div class="exp exp-datos">Códigos: ${esc(e.codigosSueltos.join(' / '))}</div>`);
  if (e.correosSueltos.length) lineas.push(`<div class="exp exp-datos">Correos: ${esc(e.correosSueltos.join(' / '))}</div>`);
  return lineas.join('');
}

function htmlFila(a) {
  const valor = estado.borradores.has(a.id) ? estado.borradores.get(a.id) : (a.asistentes == null ? '' : String(a.asistentes));
  const st = estadoFila(a);
  const puede = puedeGuardar();
  return `<div class="fila ${st.clase}" id="c-${esc(a.id)}" data-id="${esc(a.id)}">
    <div class="c-hora"><b>${esc(a.hora)}</b>${marcaTiempo(a)}</div>
    <div class="c-charla">
      <div class="c-titulo">${esc(a.charla)}${a.estado === 'PENDIENTE' ? ' <span class="etq-pendiente">PENDIENTE — expositor por confirmar</span>' : ''}</div>
      ${htmlExpositores(a)}
    </div>
    <div class="c-num">
      <input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="6" placeholder="—"
        value="${esc(valor)}" data-id="${esc(a.id)}" aria-label="Asistentes: ${esc(a.charla)}" ${puede ? '' : 'disabled'}>
    </div>
    <div class="c-estado">
      <span class="estado ${st.estado}">${esc(st.texto)}</span>
      <button type="button" class="btn-mini" data-guardar="${esc(a.id)}" ${puede && !estado.guardando.has(a.id) ? '' : 'disabled'}>${estado.guardando.has(a.id) ? '…' : 'Guardar'}</button>
    </div>
  </div>`;
}

function marcaTiempo(a) {
  if (enCurso(a)) return '<span class="t-curso">En curso</span>';
  if (yaTermino(a)) return '<span class="t-atr">Ya terminó</span>';
  return '';
}

/** Texto y colores del estado de una charla. */
function estadoFila(a) {
  const extra = yaTermino(a) && !estado.borradores.has(a.id) ? ' atrasada' : '';
  if (estado.guardando.has(a.id)) return { clase: 'modificada', estado: 'guardando', texto: 'Guardando…' };
  if (estado.errores.has(a.id)) return { clase: 'con-error', estado: 'err', texto: estado.errores.get(a.id) };
  if (estado.borradores.has(a.id)) return { clase: 'modificada', estado: 'mod', texto: 'Sin guardar · Enter' };
  if (a.asistentes != null) {
    const quien = a.registradoPor ? ' · ' + a.registradoPor : '';
    return { clase: 'guardada', estado: 'ok', texto: a.horaRegistro ? `✓ ${a.horaRegistro}${quien}` : '✓ Editado en la hoja' };
  }
  return { clase: extra.trim(), estado: 'sin', texto: 'Sin registrar' };
}

/** Actualiza una fila sin redibujar la tabla (no quita el foco del campo). */
function actualizarFila(id) {
  const fila = document.getElementById('c-' + id);
  const a = actividad(id);
  if (!fila || !a) return;
  const st = estadoFila(a);
  fila.className = 'fila ' + st.clase;
  const est = fila.querySelector('.estado');
  est.className = 'estado ' + st.estado;
  est.textContent = st.texto;
  fila.querySelector('.c-hora').innerHTML = `<b>${esc(a.hora)}</b>${marcaTiempo(a)}`;
  const inp = fila.querySelector('input');
  inp.disabled = !puedeGuardar();
  if (!estado.borradores.has(id) && document.activeElement !== inp) inp.value = a.asistentes == null ? '' : String(a.asistentes);
  const btn = fila.querySelector('[data-guardar]');
  btn.disabled = !puedeGuardar() || estado.guardando.has(id);
  btn.textContent = estado.guardando.has(id) ? '…' : 'Guardar';
}

function actualizarResumen() {
  const acts = actsDe(estado.salon, estado.dia);
  const reg = acts.filter((a) => a.asistentes != null);
  $('resTotal').textContent = reg.reduce((s, a) => s + a.asistentes, 0).toLocaleString('es-CR');
  $('resCharlas').textContent = `${reg.length} / ${acts.length}`;
  $('resBarra').style.width = (acts.length ? Math.round((reg.length / acts.length) * 100) : 0) + '%';
  $('resPend').textContent = acts.filter(yaTermino).length;
  const n = estado.borradores.size;
  const salones = new Set([...estado.borradores.keys()].map((id) => (actividad(id) || {}).salon));
  $('dockSum').innerHTML = n
    ? `<b>${n} cambio${n === 1 ? '' : 's'} sin guardar</b>${salones.size > 1 ? ` en ${salones.size} salones` : ''}`
    : '<b>Todo guardado</b>';
  const btn = $('btnGuardarTodo');
  btn.textContent = n ? `Guardar todo (${n})` : 'Guardar todo';
  btn.disabled = !n || !puedeGuardar();
}

function reemplazarActividad(nueva) {
  const lista = estado.datos && estado.datos.actividades;
  if (!lista) return;
  const i = lista.findIndex((a) => a.id === nueva.id);
  if (i >= 0) lista[i] = nueva;
}

/** Después de guardar: refresca fila, totales, días y cuentas de cada simposio. */
function trasGuardar(ids) {
  ids.forEach(actualizarFila);
  actualizarResumen();
  renderDias();
  document.querySelectorAll('#tabla .bloque').forEach((b) => {
    const filas = [...b.querySelectorAll('.fila')].map((f) => actividad(f.dataset.id)).filter(Boolean);
    b.querySelector('.b-cuenta').textContent = `${filas.filter((a) => a.asistentes != null).length}/${filas.length}`;
  });
}

// ---------------------------------------------------------------------------
//  Registro: escribir y guardar
// ---------------------------------------------------------------------------
function alEscribir(inp) {
  const limpio = inp.value.replace(/\D+/g, '').slice(0, 6);
  if (limpio !== inp.value) inp.value = limpio;
  const id = inp.dataset.id;
  const a = actividad(id);
  const guardado = a && a.asistentes != null ? String(a.asistentes) : '';
  const antes = estado.borradores.size;
  if (limpio === guardado) estado.borradores.delete(id); else estado.borradores.set(id, limpio);
  estado.errores.delete(id);
  actualizarFila(id);
  actualizarResumen();
  if (antes !== estado.borradores.size) renderDias();
}

/** Deshace lo escrito en una fila (Esc). */
function deshacer(id) {
  estado.borradores.delete(id);
  estado.errores.delete(id);
  const inp = document.querySelector(`#tabla input[data-id="${CSS.escape(id)}"]`);
  const a = actividad(id);
  if (inp && a) inp.value = a.asistentes == null ? '' : String(a.asistentes);
  trasGuardar([id]);
}

function avisarNombre() {
  if (nombreUsuario() || estado.avisoNombre) return;
  estado.avisoNombre = true;
  toast('Consejo: escriba su nombre arriba ("Registra") para que quede quién anotó cada número.');
}

async function guardarUno(id) {
  if (!puedeGuardar() || estado.guardando.has(id)) return;
  const a = actividad(id);
  const valor = estado.borradores.has(id) ? estado.borradores.get(id) : (a && a.asistentes != null ? String(a.asistentes) : '');
  if (valor === '') {
    estado.errores.set(id, 'Escriba la cantidad de asistentes.');
    return actualizarFila(id);
  }
  if (!estado.borradores.has(id)) return; // nada nuevo que guardar
  avisarNombre();
  estado.guardando.add(id);
  estado.errores.delete(id);
  actualizarFila(id);
  try {
    const r = await apiOk('guardarAsistencia', { id, valor, usuario: nombreUsuario() });
    reemplazarActividad(r.actividad);
    if (estado.borradores.get(id) === valor) estado.borradores.delete(id);
  } catch (e) {
    estado.errores.set(id, e.message + ' Enter para reintentar.');
  } finally {
    estado.guardando.delete(id);
    trasGuardar([id]);
  }
}

async function guardarTodo() {
  if (!puedeGuardar()) return;
  const items = [];
  [...estado.borradores.entries()].forEach(([id, valor]) => {
    if (estado.guardando.has(id)) return;
    if (valor === '') { estado.errores.set(id, 'Escriba la cantidad de asistentes.'); actualizarFila(id); return; }
    items.push({ id, valor });
  });
  if (!items.length) return;
  avisarNombre();
  const btn = $('btnGuardarTodo');
  btn.disabled = true; btn.textContent = 'Guardando…';
  items.forEach((it) => { estado.guardando.add(it.id); estado.errores.delete(it.id); actualizarFila(it.id); });
  let ok = 0; let mal = 0;
  try {
    const r = await api('guardarLote', { items, usuario: nombreUsuario() });
    if (!r.resultados) throw errorApp(r.error || 'No se pudo guardar.', r.codigo);
    r.resultados.forEach((res) => {
      const enviado = items.find((it) => it.id === res.id);
      if (res.ok) {
        ok++;
        reemplazarActividad(res.actividad);
        if (enviado && estado.borradores.get(res.id) === enviado.valor) estado.borradores.delete(res.id);
      } else {
        mal++;
        estado.errores.set(res.id, res.error);
      }
    });
  } catch (e) {
    mal = items.length;
    items.forEach((it) => estado.errores.set(it.id, e.message));
  } finally {
    items.forEach((it) => estado.guardando.delete(it.id));
    trasGuardar(items.map((it) => it.id));
  }
  if (mal) toast(`${ok} guardado(s), ${mal} con error. Revise las filas en rojo.`, 'err');
  else toast(`${ok} registro(s) guardado(s).`, 'ok');
}

/** Mueve el cursor al campo anterior/siguiente de la tabla. */
function moverFoco(desde, paso) {
  const campos = [...document.querySelectorAll('#tabla input[data-id]:not(:disabled)')];
  const i = campos.indexOf(desde);
  const sig = campos[i + paso];
  if (sig) { sig.focus(); sig.select(); sig.scrollIntoView({ block: 'nearest' }); }
  return !!sig;
}

/** Al abrir un salón con mouse, deja el cursor en la primera charla sin registrar. */
function enfocarPrimeraVacia() {
  if (!punteroFino()) return;
  const campos = [...document.querySelectorAll('#tabla input[data-id]:not(:disabled)')];
  const vacio = campos.find((c) => c.value === '') || campos[0];
  if (vacio) vacio.focus({ preventScroll: true });
}

function elegirDia(dia) {
  estado.dia = dia;
  fijarHash();
  renderSalon();
  window.scrollTo(0, 0);
  enfocarPrimeraVacia();
}

// ---------------------------------------------------------------------------
//  PIN de administrador
// ---------------------------------------------------------------------------
function mostrarPin() {
  mostrarVista('vPin', 'Administración', 'Escriba el PIN de administrador.');
  $('inpPin').value = '';
  mostrarError('errorPin', '');
  setTimeout(() => $('inpPin').focus(), 50);
}

async function enviarPin(ev) {
  ev.preventDefault();
  const pin = $('inpPin').value.trim();
  if (!pin) return mostrarError('errorPin', 'Escriba el PIN.');
  const btn = $('btnEntrar');
  btn.disabled = true; btn.textContent = 'Verificando…';
  mostrarError('errorPin', '');
  try {
    const r = await apiOk('login', { salon: '', pin });
    Sesion.guardarLogin(r);
    $('inpPin').value = '';
    ruta();
  } catch (e) {
    mostrarError('errorPin', e.message);
    $('inpPin').select();
  } finally {
    btn.disabled = false; btn.textContent = 'Entrar';
  }
}

// ---------------------------------------------------------------------------
//  Pantalla 5: administrador
// ---------------------------------------------------------------------------
const adm = { borradores: new Map(), errores: new Map(), guardando: new Set() };

async function mostrarAdmin() {
  const ses = Sesion.admin();
  if (!ses) return mostrarPin();
  mostrarVista('vAdmin', 'Administración', 'Totales, charlas atrasadas, correcciones y bitácora.');
  mostrarError('errorAdmin', '');
  if (estado.admin) renderAdmin();
  else $('admTotales').innerHTML = '<div class="cargando"><span class="spinner"></span> Cargando…</div>';
  await cargarAdmin(false);
}

async function cargarAdmin(silencioso) {
  const ses = Sesion.admin();
  if (!ses) return;
  try {
    const r = await apiOk('getResumenAdmin', { token: ses.token });
    estado.admin = r;
    estado.ultimaCarga = Date.now();
    if (estado.vista !== 'vAdmin') return;
    if (silencioso && (escribiendo() || adm.borradores.size)) return;
    llenarFiltros();
    renderAdmin();
    if (estado.admTab === 'bitacora') cargarBitacora();
  } catch (e) {
    if (!silencioso) mostrarError('errorAdmin', e.message);
  }
}

function llenarFiltros() {
  const r = estado.admin;
  const opciones = (sel, valores, todos) => {
    const actual = sel.value;
    sel.innerHTML = `<option value="">${todos}</option>` + valores.map((v) => `<option>${esc(v)}</option>`).join('');
    if (valores.includes(actual)) sel.value = actual;
  };
  opciones($('fDia'), r.dias, 'Todos los días');
  const salones = [...new Set(r.salones.map((s) => s.salon).concat(r.actividades.map((a) => a.salon)))]
    .sort((a, b) => a.localeCompare(b, 'es'));
  opciones($('fSalon'), salones, 'Todos los salones');
}

function filasFiltradas() {
  const r = estado.admin;
  if (!r) return [];
  const dia = norm($('fDia').value); const salon = norm($('fSalon').value);
  const est = $('fEstado').value; const sin = $('fSinRegistrar').checked;
  const txt = norm($('fTexto').value);
  return r.actividades.filter((a) =>
    (!dia || norm(a.dia) === dia) &&
    (!salon || norm(a.salon) === salon) &&
    (!est || a.estado === est) &&
    (!sin || a.asistentes == null) &&
    (!txt || norm([a.id, a.charla, a.expositor, a.simposio, a.entidad, a.codigo, a.correo].join(' ')).includes(txt)));
}

function totalesPor(filas, claveFn, etiquetaFn) {
  const m = new Map();
  filas.forEach((a) => {
    const k = claveFn(a);
    if (!m.has(k)) m.set(k, { etiqueta: etiquetaFn(a), total: 0, reg: 0, asis: 0 });
    const t = m.get(k);
    t.total++;
    if (a.asistentes != null) { t.reg++; t.asis += a.asistentes; }
  });
  return [...m.values()];
}

function renderAdmin() {
  const r = estado.admin;
  if (!r) return;
  const bloq = $('admEstadoBloqueo');
  bloq.className = 'estado-bloqueo ' + (r.bloqueo ? 'si' : 'no');
  bloq.textContent = r.bloqueo
    ? 'Edición BLOQUEADA: los encargados solo pueden consultar.'
    : 'Edición abierta: los encargados pueden guardar.';
  $('admBloqueo').textContent = r.bloqueo ? 'Desbloquear edición' : 'Bloquear edición';
  $('admHoja').href = r.urlHoja || '#';
  document.querySelectorAll('.tabs-admin button').forEach((b) => b.classList.toggle('activa', b.dataset.tab === estado.admTab));
  ['totales', 'charlas', 'atrasadas', 'bitacora'].forEach((t) => {
    $('adm' + t.charAt(0).toUpperCase() + t.slice(1)).hidden = t !== estado.admTab;
  });

  const filas = filasFiltradas();
  const atrasadas = filas.filter((a) => a.atrasada);
  $('nAtrasadas').textContent = atrasadas.length;

  if (estado.admTab === 'totales') renderTotales(filas, atrasadas.length);
  if (estado.admTab === 'charlas') renderTablaCharlas($('admCharlas'), filas,
    `${filas.length} charla(s) según los filtros. Puede corregir cualquier asistencia; queda en la bitácora. Deje el campo vacío y guarde para borrar un registro.`);
  if (estado.admTab === 'atrasadas') renderTablaCharlas($('admAtrasadas'), atrasadas,
    `Charlas que ya terminaron y no tienen asistencia (según filtros). Hora de referencia: ${fechaHora(r.ahora)}` +
    (r.referenciaFechas === 'semana actual' ? ' — Aviso: falta "Fecha_inicio" en Config; se asume que el congreso es esta semana.' : '') + '.');
  if (estado.admTab === 'bitacora') renderBitacora();
}

function renderTotales(filas, nAtrasadas) {
  const reg = filas.filter((a) => a.asistentes != null);
  const total = reg.reduce((s, a) => s + a.asistentes, 0);
  const prom = reg.length ? Math.round(total / reg.length) : 0;
  const tabla = (titulo, cols, datos) => `<h4 class="sub">${titulo}</h4>
    <div class="tabla-envoltura"><table><thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${c.t}</th>`).join('')}</tr></thead>
    <tbody>${datos.map((d) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.f(d)}</td>`).join('')}</tr>`).join('') ||
      `<tr><td colspan="${cols.length}">Sin datos</td></tr>`}</tbody></table></div>`;
  const cols = (nombre) => [
    { t: nombre, f: (d) => d.etiqueta },
    { t: 'Registradas', num: true, f: (d) => `${d.reg} / ${d.total}` },
    { t: 'Asistentes', num: true, f: (d) => d.asis.toLocaleString('es-CR') }
  ];
  const dias = estado.admin.dias;
  const porDia = totalesPor(filas, (a) => norm(a.dia), (a) => esc(a.dia))
    .sort((x, y) => dias.findIndex((d) => norm(d) === norm(x.etiqueta)) - dias.findIndex((d) => norm(d) === norm(y.etiqueta)));
  const porSalon = totalesPor(filas, (a) => norm(a.salon), (a) => esc(a.salon)).sort((x, y) => x.etiqueta.localeCompare(y.etiqueta, 'es'));
  const porSimposio = totalesPor(filas, (a) => [norm(a.dia), norm(a.salon), norm(a.simposio), norm(a.entidad)].join('|'),
    (a) => `<b>${esc(a.simposio)}</b><br><small>${esc(a.entidad)} · ${esc(a.salon)} · ${esc(a.dia)}</small>`);

  $('admTotales').innerHTML = `
    <div class="kpis">
      <div class="kpi"><b>${total.toLocaleString('es-CR')}</b><span>asistentes (total general)</span></div>
      <div class="kpi"><b>${reg.length} / ${filas.length}</b><span>charlas registradas</span></div>
      <div class="kpi"><b>${prom}</b><span>promedio por charla registrada</span></div>
      <div class="kpi"><b>${nAtrasadas}</b><span>ya pasaron y sin registrar</span></div>
    </div>
    <p class="nota">Los totales respetan los filtros de arriba.</p>
    ${tabla('Por día', cols('Día'), porDia)}
    ${tabla('Por salón', cols('Salón'), porSalon)}
    ${tabla('Por simposio', cols('Simposio'), porSimposio)}`;
}

function renderTablaCharlas(cont, filas, nota) {
  cont.innerHTML = `<p class="nota">${esc(nota)}</p>
    <div class="tabla-envoltura"><table>
      <thead><tr><th>ID</th><th>Día</th><th>Salón</th><th>Hora</th><th>Simposio / Charla</th><th>Expositor</th><th>Asistentes</th></tr></thead>
      <tbody>${filas.map(htmlFilaAdmin).join('') || '<tr><td colspan="7">No hay charlas con estos filtros.</td></tr>'}</tbody>
    </table></div>`;
}

function htmlFilaAdmin(a) {
  const valor = adm.borradores.has(a.id) ? adm.borradores.get(a.id) : (a.asistentes == null ? '' : String(a.asistentes));
  const st = estadoAdmin(a);
  return `<tr id="f-${esc(a.id)}" class="${a.estado === 'PENDIENTE' ? 'fila-pendiente' : ''} ${a.atrasada ? 'fila-atrasada' : ''}">
    <td>${esc(a.id)}</td><td>${esc(a.dia)}</td><td>${esc(a.salon)}</td><td style="white-space:nowrap">${esc(a.hora)}</td>
    <td><small>${esc(a.simposio)}</small><br>${esc(a.charla)}${a.estado === 'PENDIENTE' ? ' <span class="tag-p">PENDIENTE</span>' : ''}</td>
    <td>${esc(a.expositor)}${a.codigo ? `<br><small>${esc(a.codigo)}</small>` : ''}</td>
    <td><div class="celda-edit">
        <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" value="${esc(valor)}" data-aid="${esc(a.id)}" aria-label="Asistentes ${esc(a.id)}">
        <button type="button" class="btn btn-primario" data-aguardar="${esc(a.id)}" ${adm.guardando.has(a.id) ? 'disabled' : ''}>Guardar</button>
      </div><div class="celda-estado ${st.c}">${esc(st.t)}</div></td>
  </tr>`;
}

function estadoAdmin(a) {
  if (adm.guardando.has(a.id)) return { c: '', t: 'Guardando…' };
  if (adm.errores.has(a.id)) return { c: 'err', t: adm.errores.get(a.id) };
  if (adm.borradores.has(a.id)) return { c: 'mod', t: 'Sin guardar' };
  if (a.asistentes != null) return { c: 'ok', t: a.fechaRegistro ? `${a.registradoPor} · ${fechaHora(a.fechaRegistro)}` : 'Editado en la hoja' };
  return { c: '', t: 'Sin registrar' };
}

function actualizarFilaAdmin(id) {
  const tr = document.getElementById('f-' + id);
  const a = estado.admin.actividades.find((x) => x.id === id);
  if (!tr || !a) return;
  const st = estadoAdmin(a);
  const el = tr.querySelector('.celda-estado');
  el.className = 'celda-estado ' + st.c; el.textContent = st.t;
  tr.querySelector('[data-aguardar]').disabled = adm.guardando.has(id);
  const inp = tr.querySelector('input');
  if (!adm.borradores.has(id) && document.activeElement !== inp) inp.value = a.asistentes == null ? '' : String(a.asistentes);
}

async function guardarAdmin(id) {
  const ses = Sesion.admin();
  if (!ses || adm.guardando.has(id)) return;
  const a = estado.admin.actividades.find((x) => x.id === id);
  const valor = adm.borradores.has(id) ? adm.borradores.get(id) : (a.asistentes == null ? '' : String(a.asistentes));
  if (valor === '' && a.asistentes == null) return;
  if (valor === '' && !confirm(`¿Borrar la asistencia registrada de ${id}? Quedará en la bitácora.`)) return;
  adm.guardando.add(id); adm.errores.delete(id); actualizarFilaAdmin(id);
  try {
    const r = await apiOk('guardarAsistencia', { id, valor, token: ses.token });
    const i = estado.admin.actividades.findIndex((x) => x.id === id);
    const nueva = r.actividad;
    nueva.atrasada = nueva.atrasada && nueva.asistentes == null;
    estado.admin.actividades[i] = nueva;
    if (adm.borradores.get(id) === valor) adm.borradores.delete(id);
    toast(`${id} guardado.`, 'ok');
  } catch (e) {
    adm.errores.set(id, e.message);
  } finally {
    adm.guardando.delete(id);
    actualizarFilaAdmin(id);
    $('nAtrasadas').textContent = filasFiltradas().filter((x) => x.atrasada).length;
  }
}

async function cargarBitacora() {
  const ses = Sesion.admin();
  if (!ses) return;
  if (!estado.bitacora) $('admBitacora').innerHTML = '<p class="nota">Cargando bitácora…</p>';
  try {
    estado.bitacora = await apiOk('getBitacora', { token: ses.token, limite: 1000 });
    if (estado.admTab === 'bitacora') renderBitacora();
  } catch (e) {
    $('admBitacora').innerHTML = `<p class="msg-error">${esc(e.message)}</p>`;
  }
}

function filasBitacora() {
  if (!estado.bitacora) return [];
  const salon = norm($('fSalon').value); const txt = norm($('fTexto').value);
  return estado.bitacora.registros.filter((b) =>
    (!salon || norm(b.salon) === salon) &&
    (!txt || norm([b.id, b.usuario, b.salon].join(' ')).includes(txt)));
}

function renderBitacora() {
  if (!estado.bitacora) return;
  const filas = filasBitacora();
  $('admBitacora').innerHTML = `<p class="nota">Últimos ${estado.bitacora.registros.length} de ${estado.bitacora.total} movimientos (el más reciente primero). Filtra por salón y texto.</p>
    <div class="tabla-envoltura"><table>
      <thead><tr><th>Fecha</th><th>Usuario</th><th>Salón</th><th>ID</th><th class="num">Anterior</th><th class="num">Nuevo</th></tr></thead>
      <tbody>${filas.map((b) => `<tr><td>${esc(b.fechaTexto)}</td><td>${esc(b.usuario)}</td><td>${esc(b.salon)}</td><td>${esc(b.id)}</td>
        <td class="num">${esc(b.anterior || '—')}</td><td class="num">${esc(b.nuevo || '—')}</td></tr>`).join('') ||
        '<tr><td colspan="6">Sin movimientos.</td></tr>'}</tbody>
    </table></div>`;
}

async function alternarBloqueo() {
  const ses = Sesion.admin();
  if (!ses || !estado.admin) return;
  const nuevo = !estado.admin.bloqueo;
  if (!confirm(nuevo ? '¿Bloquear la edición? Los encargados solo podrán consultar.' : '¿Desbloquear la edición para los encargados?')) return;
  const btn = $('admBloqueo'); btn.disabled = true;
  try {
    const r = await apiOk('setBloqueo', { valor: nuevo ? 'SI' : 'NO', token: ses.token });
    estado.admin.bloqueo = r.bloqueo;
    if (estado.datos) estado.datos.bloqueo = r.bloqueo;
    renderAdmin();
    toast(r.bloqueo ? 'Edición bloqueada.' : 'Edición desbloqueada.', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ---------- Exportar CSV de lo que se está viendo ----------
function csv(filas) {
  const celda = (v) => {
    const t = v == null ? '' : String(v);
    return /[",;\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  return '﻿' + filas.map((f) => f.map(celda).join(',')).join('\r\n');
}

function exportarCsv() {
  if (!estado.admin) return;
  let filas;
  const tab = estado.admTab;
  if (tab === 'bitacora') {
    filas = [['Fecha', 'Usuario', 'Salon', 'ID_actividad', 'Valor_anterior', 'Valor_nuevo']]
      .concat(filasBitacora().map((b) => [b.fechaTexto, b.usuario, b.salon, b.id, b.anterior, b.nuevo]));
  } else if (tab === 'totales') {
    const datos = filasFiltradas();
    const bloque = (titulo, t) => [[titulo, 'Charlas', 'Registradas', 'Asistentes']].concat(t.map((x) => [x.etiqueta, x.total, x.reg, x.asis]));
    const limpio = (s) => s.replace(/<br>/g, ' — ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
    const porSim = totalesPor(datos, (a) => [a.dia, a.salon, a.simposio, a.entidad].join('|'),
      (a) => `${a.simposio} — ${a.entidad} — ${a.salon} — ${a.dia}`);
    const tot = datos.filter((a) => a.asistentes != null);
    filas = [['Total general', datos.length, tot.length, tot.reduce((s, a) => s + a.asistentes, 0)], []]
      .concat(bloque('Día', totalesPor(datos, (a) => a.dia, (a) => a.dia)), [[]],
        bloque('Salón', totalesPor(datos, (a) => a.salon, (a) => a.salon)), [[]],
        bloque('Simposio', porSim.map((x) => Object.assign({}, x, { etiqueta: limpio(x.etiqueta) }))));
  } else {
    const datos = tab === 'atrasadas' ? filasFiltradas().filter((a) => a.atrasada) : filasFiltradas();
    filas = [['ID', 'Dia', 'Salon', 'Hora', 'Entidad', 'Simposio', 'Charla', 'Expositor', 'Codigo_medico', 'Correo', 'Estado',
      'Asistentes', 'Registrado_por', 'Fecha_registro']]
      .concat(datos.map((a) => [a.id, a.dia, a.salon, a.hora, a.entidad, a.simposio, a.charla, a.expositor, a.codigo, a.correo,
        a.estado, a.asistentes == null ? '' : a.asistentes, a.registradoPor, fechaHora(a.fechaRegistro)]));
  }
  const blob = new Blob([csv(filas)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement('a');
  const hoy = new Date().toISOString().slice(0, 10);
  enlace.href = url; enlace.download = `CMN2026_${tab}_${hoy}.csv`;
  document.body.appendChild(enlace); enlace.click(); enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}


// ---------------------------------------------------------------------------
//  Eventos
// ---------------------------------------------------------------------------
function hayBorradores() { return estado.borradores.size > 0 || adm.borradores.size > 0; }

function iniciar() {
  if (!apiConfigurada()) $('avisoConfig').hidden = false;
  const red = () => { $('avisoRed').hidden = navigator.onLine !== false; };
  window.addEventListener('online', () => { red(); refrescarSiToca(true); });
  window.addEventListener('offline', red);
  red();

  // Nombre de quien registra (se recuerda en esta computadora)
  $('inpNombre').value = leerLocal(CLAVE_NOMBRE);
  $('inpNombre').addEventListener('input', () => guardarLocal(CLAVE_NOMBRE, nombreUsuario()));

  $('btnAdmin').addEventListener('click', () => ir('#/admin'));
  $('btnVolver').addEventListener('click', () => {
    if (adm.borradores.size && !confirm('Hay correcciones sin guardar en Administración. ¿Salir de todos modos?')) return;
    ir('#/');
  });
  $('btnRecargar').addEventListener('click', () => {
    if (estado.vista === 'vAdmin') { estado.bitacora = null; cargarAdmin(false); return; }
    cargando(!estado.datos);
    cargarDatos(false);
  });
  $('formPin').addEventListener('submit', enviarPin);

  // Pantalla principal: carrusel de salones
  $('gridSalones').addEventListener('click', (e) => {
    const b = e.target.closest('[data-salon]');
    if (b) ir(hashSalon(b.dataset.salon));
  });
  let rafCarrusel = 0;
  $('gridSalones').addEventListener('scroll', () => {
    cancelAnimationFrame(rafCarrusel);
    rafCarrusel = requestAnimationFrame(() => carrusel.actualizar());
  }, { passive: true });
  window.addEventListener('resize', () => carrusel.actualizar());
  $('carPrev').addEventListener('click', () => carrusel.mover(-1));
  $('carNext').addEventListener('click', () => carrusel.mover(1));
  $('carPuntos').addEventListener('click', (e) => {
    const p = e.target.closest('[data-i]');
    if (p) carrusel.ir(Number(p.dataset.i));
  });
  $('gridSalones').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const ts = carrusel.tarjetas();
    const i = Math.max(0, ts.indexOf(document.activeElement));
    const j = Math.max(0, Math.min(ts.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
    ts[j].focus({ preventScroll: true });
    carrusel.ir(j);
  });

  // Días del salón
  $('tabsDias').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dia]');
    if (b && !b.disabled) elegirDia(b.dataset.dia);
  });

  // Tabla de charlas: teclado pensado para registrar rápido
  const tabla = $('tabla');
  tabla.addEventListener('input', (e) => { if (e.target.matches('input[data-id]')) alEscribir(e.target); });
  tabla.addEventListener('keydown', (e) => {
    const inp = e.target;
    if (!inp.matches('input[data-id]')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (estado.borradores.has(inp.dataset.id) || estado.errores.has(inp.dataset.id)) guardarUno(inp.dataset.id);
      moverFoco(inp, e.shiftKey ? -1 : 1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moverFoco(inp, e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Escape') {
      deshacer(inp.dataset.id);
    }
  });
  tabla.addEventListener('focusin', (e) => { if (e.target.matches('input[data-id]')) e.target.select(); });
  tabla.addEventListener('click', (e) => {
    const b = e.target.closest('[data-guardar]');
    if (b) guardarUno(b.dataset.guardar);
  });
  // Si llegaron datos nuevos mientras escribía, se redibuja al salir del campo.
  tabla.addEventListener('focusout', () => {
    setTimeout(() => { if (estado.renderPendiente && !escribiendo() && estado.vista === 'vSalon') renderTabla(); }, 400);
  });
  $('btnGuardarTodo').addEventListener('click', guardarTodo);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && estado.vista === 'vSalon') {
      e.preventDefault();
      guardarTodo();
    }
  });

  // Administrador
  $('admRecargar').addEventListener('click', () => { estado.bitacora = null; cargarAdmin(false); });
  $('admBloqueo').addEventListener('click', alternarBloqueo);
  $('admCsv').addEventListener('click', exportarCsv);
  $('admSalir').addEventListener('click', () => {
    if (adm.borradores.size && !confirm('Hay correcciones sin guardar. ¿Cerrar la sesión de todos modos?')) return;
    Sesion.olvidarToken();
    estado.admin = null; estado.bitacora = null; adm.borradores.clear(); adm.errores.clear();
    ir('#/');
  });
  document.querySelector('.tabs-admin').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    estado.admTab = b.dataset.tab;
    renderAdmin();
    if (estado.admTab === 'bitacora') cargarBitacora();
  });
  ['fDia', 'fSalon', 'fEstado', 'fSinRegistrar'].forEach((id) => $(id).addEventListener('change', renderAdmin));
  let tFiltro = null;
  $('fTexto').addEventListener('input', () => { clearTimeout(tFiltro); tFiltro = setTimeout(renderAdmin, 250); });
  const vAdmin = $('vAdmin');
  vAdmin.addEventListener('input', (e) => {
    const inp = e.target.closest('input[data-aid]');
    if (!inp) return;
    inp.value = inp.value.replace(/\D+/g, '').slice(0, 6);
    const id = inp.dataset.aid;
    const a = estado.admin.actividades.find((x) => x.id === id);
    const guardado = a.asistentes == null ? '' : String(a.asistentes);
    if (inp.value === guardado) adm.borradores.delete(id); else adm.borradores.set(id, inp.value);
    adm.errores.delete(id);
    actualizarFilaAdmin(id);
  });
  vAdmin.addEventListener('click', (e) => {
    const b = e.target.closest('[data-aguardar]');
    if (b) guardarAdmin(b.dataset.aguardar);
  });
  vAdmin.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input[data-aid]')) { e.preventDefault(); guardarAdmin(e.target.dataset.aid); }
  });

  // Actualización automática cada 60 s (sin borrar lo que se está escribiendo)
  setInterval(() => refrescarSiToca(false), REFRESCO_MS);
  document.addEventListener('visibilitychange', () => refrescarSiToca(false));

  window.addEventListener('beforeunload', (e) => {
    if (hayBorradores()) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('hashchange', ruta);
  ruta();
}

function refrescarSiToca(forzar) {
  if (document.visibilityState === 'hidden' || navigator.onLine === false) return;
  if (!forzar && Date.now() - estado.ultimaCarga < REFRESCO_MS - 2000) return;
  if ((estado.vista === 'vSalon' || estado.vista === 'vInicio') && estado.datos) cargarDatos(true);
  else if (estado.vista === 'vAdmin' && estado.admin) cargarAdmin(true);
}

document.addEventListener('DOMContentLoaded', iniciar);
