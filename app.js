/* =========================================================================
   CMN 2026 — Registro de asistencia por charla (frontend)
   HTML + CSS + JavaScript puro. Todos los datos vienen de la hoja de Google
   a través del Apps Script publicado como aplicación web.
   ========================================================================= */

// URL de la aplicación web de Apps Script (termina en /exec).
// Es lo ÚNICO que hay que cambiar en este archivo.
const API_URL = 'https://script.google.com/macros/s/AKfycbwO7EsIIo6AlRPD4Kwn1CTui--G04Trrb4LD0yQzVtq099P7RsNBii5UB_v6mSBplOJ/exec';

const REFRESCO_MS = 60 * 1000;   // la vista se actualiza sola cada 60 s
const TIMEOUT_MS = 30 * 1000;    // tiempo máximo de espera por respuesta
const CLAVE_SESION = 'cmn2026_sesion';
const ZONA = 'America/Costa_Rica';

// ---------------------------------------------------------------------------
//  Estado de la aplicación
// ---------------------------------------------------------------------------
const estado = {
  inicio: null,            // respuesta de getSalones
  salonClave: null,        // salón abierto (normalizado)
  salon: null,             // respuesta de getActividades
  firmaSalon: '',
  dia: null,               // día seleccionado
  borradores: new Map(),   // id → texto escrito y no guardado
  errores: new Map(),      // id → mensaje de error del último intento
  guardando: new Set(),    // ids que se están guardando
  renderPendiente: false,  // llegaron datos nuevos mientras el usuario escribía
  ultimaCarga: 0,
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
function errorApp(mensaje, codigo) { const e = new Error(mensaje); e.codigo = codigo || 'ERROR'; return e; }

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
//  Sesión (sessionStorage: dura mientras la pestaña esté abierta)
// ---------------------------------------------------------------------------
const Sesion = {
  _memoria: { salones: {}, admin: null },
  leer() {
    try {
      const s = JSON.parse(sessionStorage.getItem(CLAVE_SESION) || 'null');
      return s && s.salones ? s : { salones: {}, admin: null };
    } catch (e) { return this._memoria; }
  },
  escribir(s) {
    this._memoria = s;
    try { sessionStorage.setItem(CLAVE_SESION, JSON.stringify(s)); } catch (e) { /* modo privado */ }
  },
  /** Token para un salón: el propio del salón o, si existe, el del administrador. */
  deSalon(salon) {
    const s = this.leer();
    return s.salones[norm(salon)] || (s.admin ? { token: s.admin.token, rol: 'admin' } : null);
  },
  admin() { return this.leer().admin; },
  guardarLogin(r, salon) {
    const s = this.leer();
    if (r.rol === 'admin') s.admin = { token: r.token };
    else s.salones[norm(salon)] = { token: r.token, rol: 'encargado', salon: r.salon };
    this.escribir(s);
  },
  olvidarToken(token) {
    const s = this.leer();
    if (s.admin && s.admin.token === token) s.admin = null;
    Object.keys(s.salones).forEach((k) => { if (s.salones[k].token === token) delete s.salones[k]; });
    this.escribir(s);
  },
  hayAlguna() { const s = this.leer(); return !!s.admin || Object.keys(s.salones).length > 0; },
  borrarTodo() { this.escribir({ salones: {}, admin: null }); }
};

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
      ? 'El servidor tardó demasiado. Revise la señal e intente de nuevo.'
      : 'Sin conexión con el servidor. Revise la señal e intente de nuevo.', 'RED');
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw errorApp('El servidor respondió con un error (' + resp.status + '). Intente de nuevo.', 'RED');
  let json;
  try { json = await resp.json(); } catch (e) {
    throw errorApp('Respuesta inesperada del servidor. Verifique que la app web esté publicada con acceso "Cualquier persona".', 'RED');
  }
  if (json && json.codigo === 'SESION' && datos && datos.token) {
    Sesion.olvidarToken(datos.token);
    setTimeout(() => { toast(json.error, 'err'); ruta(); }, 0);
  }
  return json;
}

/** Igual que api() pero lanza error si la respuesta trae ok:false. */
async function apiOk(accion, datos) {
  const r = await api(accion, datos);
  if (!r || !r.ok) throw errorApp((r && r.error) || 'Error desconocido.', r && r.codigo);
  return r;
}

// ---------------------------------------------------------------------------
//  Navegación (#/  ·  #/salon/Real%201/Martes  ·  #/admin)
// ---------------------------------------------------------------------------
function ir(hash) {
  if (location.hash === hash) ruta(); else location.hash = hash;
}
function hashSalon(salon, dia) {
  return '#/salon/' + encodeURIComponent(salon) + (dia ? '/' + encodeURIComponent(dia) : '');
}

function ruta() {
  const partes = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (partes[0] === 'salon' && partes[1]) return mostrarSalon(partes[1], partes[2]);
  if (partes[0] === 'admin') return mostrarAdmin();
  return mostrarInicio();
}

function mostrarVista(id, titulo, subtitulo, conVolver) {
  estado.vista = id;
  ['vInicio', 'vPin', 'vSalon', 'vAdmin'].forEach((v) => { $(v).hidden = v !== id; });
  $('app').classList.toggle('ancho', id === 'vAdmin');
  $('top').classList.toggle('compacto', id !== 'vInicio');
  $('top').classList.toggle('ancho', id === 'vAdmin');
  $('kicker').textContent = (estado.inicio && estado.inicio.evento) || 'Congreso Médico Nacional 2026';
  $('tituloEvento').textContent = titulo || 'Asistencia';
  $('subtitulo').textContent = subtitulo || '';
  if (id !== 'vInicio') $('chips').innerHTML = '';
  $('btnVolver').hidden = !conVolver;
  $('btnSalir').hidden = !(Sesion.hayAlguna() && id !== 'vPin');
  $('cargando').hidden = true;
  document.title = (titulo ? titulo + ' · ' : '') + 'Asistencia CMN 2026';
}
function cargando(si) { $('cargando').hidden = !si; }
function mostrarError(id, msg) { const el = $(id); el.textContent = msg || ''; el.hidden = !msg; }

// ---------------------------------------------------------------------------
//  Pantalla 1: inicio
// ---------------------------------------------------------------------------
async function mostrarInicio() {
  mostrarVista('vInicio', null, 'Registro de asistentes por charla. Toque su salón y anote cuántas personas hubo en cada charla.', false);
  mostrarError('errorInicio', '');
  if (estado.inicio) renderInicio(); else cargando(true);
  try {
    estado.inicio = await apiOk('getSalones');
    if (estado.vista === 'vInicio') { $('kicker').textContent = estado.inicio.evento; renderInicio(); }
  } catch (e) {
    mostrarError('errorInicio', e.message);
  } finally {
    cargando(false);
  }
}

function renderInicio() {
  const r = estado.inicio;
  $('bloqueoInicio').hidden = !r.bloqueo;
  const total = r.salones.reduce((n, s) => n + s.total, 0);
  const reg = r.salones.reduce((n, s) => n + s.registradas, 0);
  $('chips').innerHTML = [`<b>${r.salones.length}</b> salones`, `<b>${total}</b> charlas`, `<b>${reg}</b> registradas`,
    r.hoy ? `Hoy: <b>${esc(r.hoy)}</b>` : `<b>${r.dias.length}</b> días`]
    .map((x) => `<span class="chip">${x}</span>`).join('');
  $('gridSalones').innerHTML = r.salones.length ? r.salones.map((s) => {
    const pct = s.total ? Math.round((s.registradas / s.total) * 100) : 0;
    return `<button type="button" class="tarjeta-salon${s.total && pct === 100 ? ' completo' : ''}" data-salon="${esc(s.salon)}">
        <span class="ph"><span class="nombre">${esc(s.salon)}</span><span class="pct">${pct}%</span></span>
        <span class="bd">
          <span class="avance">${s.registradas} / ${s.total} charlas registradas</span>
          <span class="bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
        </span>
      </button>`;
  }).join('') : '<p class="vacio">No hay salones activos en la hoja "Salones".</p>';
}

// ---------------------------------------------------------------------------
//  Pantalla 2: PIN
// ---------------------------------------------------------------------------
let pinSalon = null; // null = administrador

function mostrarPin(salon) {
  pinSalon = salon;
  mostrarVista('vPin', salon || 'Administrador', salon ? 'Ingrese el PIN del salón' : 'Ingrese el PIN de administrador', true);
  $('pinTitulo').textContent = salon || 'Administrador';
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
    const r = await apiOk('login', { salon: pinSalon || '', pin });
    Sesion.guardarLogin(r, pinSalon);
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
//  Pantallas 3 y 4: días y actividades del salón
// ---------------------------------------------------------------------------
async function mostrarSalon(nombre, dia) {
  const ses = Sesion.deSalon(nombre);
  if (!ses) return mostrarPin(nombre);

  const clave = norm(nombre);
  if (estado.salonClave !== clave) {
    estado.salonClave = clave;
    estado.salon = null;
    estado.firmaSalon = '';
    estado.dia = null;
  }
  if (dia) estado.dia = dia;
  mostrarVista('vSalon', nombre, ses.rol === 'admin' ? 'Modo administrador · puede corregir cualquier charla' : 'Anote los asistentes de cada charla y toque Guardar.', true);
  mostrarError('errorSalon', '');
  if (estado.salon) renderSalon(); else { $('listaActividades').innerHTML = ''; $('tabsDias').innerHTML = ''; cargando(true); }
  await cargarSalon(false);
}

function tokenSalon() {
  const s = estado.salon ? estado.salon.salon : estado.salonClave;
  const ses = Sesion.deSalon(s);
  return ses ? ses.token : '';
}

async function cargarSalon(silencioso) {
  const nombre = estado.salon ? estado.salon.salon : decodeURIComponent((location.hash.split('/')[2] || ''));
  const clave = estado.salonClave;
  const token = tokenSalon();
  if (!token) return;
  try {
    const r = await apiOk('getActividades', { salon: nombre, token });
    if (estado.salonClave !== clave) return; // el usuario ya cambió de salón
    estado.ultimaCarga = Date.now();
    estado.salon = r;
    elegirDia();
    const firma = JSON.stringify([r.actividades, r.bloqueo, r.puedeGuardar, r.dias, estado.dia]);
    $('actualizado').textContent = 'Actualizado a las ' + horaActual();
    if (silencioso && firma === estado.firmaSalon) return;
    estado.firmaSalon = firma;
    if (estado.vista !== 'vSalon') return;
    if (silencioso && escribiendo()) { estado.renderPendiente = true; return; }
    renderSalon();
  } catch (e) {
    if (silencioso) {
      $('actualizado').textContent = 'No se pudo actualizar (' + e.message + ') Se reintentará.';
    } else {
      mostrarError('errorSalon', e.message);
    }
  } finally {
    cargando(false);
  }
}

/** ¿El usuario tiene el cursor en un campo de asistencia? */
function escribiendo() {
  const a = document.activeElement;
  return !!(a && a.tagName === 'INPUT' && (a.closest('#listaActividades') || a.closest('#vAdmin')));
}

function elegirDia() {
  const r = estado.salon;
  const activos = r.dias.filter((d) => d.activo).map((d) => d.dia);
  const actual = activos.find((d) => norm(d) === norm(estado.dia));
  if (actual) { estado.dia = actual; return; }
  const hoy = activos.find((d) => norm(d) === norm(r.hoy));
  estado.dia = hoy || activos[0] || null;
}

function actividadesDelDia() {
  if (!estado.salon) return [];
  return estado.salon.actividades.filter((a) => norm(a.dia) === norm(estado.dia));
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

function renderSalon() {
  estado.renderPendiente = false;
  const r = estado.salon;
  if (!r) return;
  const puede = r.puedeGuardar;

  renderDias();

  $('bloqueoSalon').hidden = puede;
  $('bloqueoSalon').textContent = r.bloqueo && !puede
    ? 'La edición está bloqueada por el administrador. Solo puede consultar.'
    : '';

  const acts = actividadesDelDia();
  if (!acts.length) {
    $('listaActividades').innerHTML = '<p class="vacio">Este salón no tiene actividades registradas en la hoja.</p>';
  } else {
    $('listaActividades').innerHTML = agruparBloques(acts).map((b) => `
      <section class="bloque">
        <header class="bloque-cab">
          <h3>${esc(b.simposio || 'Sin simposio')}</h3>
          ${b.entidad ? `<div class="entidad">${esc(b.entidad)}</div>` : ''}
          ${b.rango ? `<div class="rango">${esc(b.rango)}</div>` : ''}
        </header>
        <div class="bloque-lista">${b.acts.map((a) => htmlCharla(a, puede)).join('')}</div>
      </section>`).join('');
  }
  actualizarResumen();
}

/** Pestañas de días: solo se activan los días con charlas; la burbuja naranja cuenta cambios sin guardar. */
function renderDias() {
  const r = estado.salon;
  if (!r) return;
  $('tabsDias').innerHTML = r.dias.map((d) => {
    const sel = norm(d.dia) === norm(estado.dia);
    const esHoy = norm(d.dia) === norm(r.hoy);
    const acts = r.actividades.filter((a) => norm(a.dia) === norm(d.dia));
    const reg = acts.filter((a) => a.asistentes != null).length;
    const pend = acts.filter((a) => estado.borradores.has(a.id)).length;
    const detalle = d.activo ? `${reg} de ${acts.length}` : 'sin charlas';
    return `<button type="button" class="tab-dia" role="tab" data-dia="${esc(d.dia)}" aria-selected="${sel}"
      ${d.activo ? '' : 'disabled'} title="${esc(d.dia)}${d.activo ? `: ${reg} de ${acts.length} charlas registradas` : ' (sin actividades)'}">
      ${pend ? `<span class="bdg" title="Cambios sin guardar">${pend}</span>` : ''}
      <b>${esc(d.dia)}</b><small>${esHoy ? '<span class="hoy">Hoy · </span>' : ''}${detalle}</small></button>`;
  }).join('');
  // Centra el día elegido dentro de la tira de pestañas (sin mover la página).
  const tira = $('tabsDias');
  const act = tira.querySelector('[aria-selected="true"]');
  if (act) tira.scrollLeft = act.offsetLeft - (tira.clientWidth - act.offsetWidth) / 2;
}

function htmlExpositores(a) {
  const e = a.expositores || { personas: [], codigosSueltos: [], correosSueltos: [] };
  const sinNombre = !e.personas.length || (e.personas.length === 1 && norm(e.personas[0].nombre) === 'pendiente');
  const items = sinNombre
    ? ['<li><span class="exp-nombre">Expositor por confirmar</span></li>']
    : e.personas.map((p) => {
      const cod = p.codigo ? (/^\d+$/.test(p.codigo) ? 'Cód. ' + p.codigo : p.codigo) : 'Cód. —';
      return `<li><span class="exp-nombre">${esc(p.nombre)}</span><br>
        <span class="exp-datos">${esc(cod)} · ${p.correo ? esc(p.correo) : '—'}</span></li>`;
    });
  if (e.codigosSueltos.length) items.push(`<li class="exp-datos">Códigos: ${esc(e.codigosSueltos.join(' / '))}</li>`);
  if (e.correosSueltos.length) items.push(`<li class="exp-datos">Correos: ${esc(e.correosSueltos.join(' / '))}</li>`);
  return `<ul class="expositores">${items.join('')}</ul>`;
}

function htmlCharla(a, puede) {
  const valor = estado.borradores.has(a.id) ? estado.borradores.get(a.id) : (a.asistentes == null ? '' : String(a.asistentes));
  const st = estadoCharla(a);
  return `<article class="charla ${st.clase}" id="c-${esc(a.id)}" data-id="${esc(a.id)}">
    <div class="charla-hora">${esc(a.hora)}</div>
    ${a.estado === 'PENDIENTE' ? '<span class="etq-pendiente">PENDIENTE — expositor por confirmar</span>' : ''}
    <h4 class="charla-titulo">${esc(a.charla)}</h4>
    ${htmlExpositores(a)}
    <div class="registro">
      <input type="text" inputmode="numeric" pattern="[0-9]*" enterkeyhint="done" autocomplete="off"
        maxlength="6" placeholder="—" value="${esc(valor)}" data-id="${esc(a.id)}"
        aria-label="Cantidad de asistentes: ${esc(a.charla)}" ${puede ? '' : 'disabled'}>
      <button type="button" class="btn btn-primario" data-guardar="${esc(a.id)}"
        ${puede && !estado.guardando.has(a.id) ? '' : 'disabled'}>${estado.guardando.has(a.id) ? '…' : 'Guardar'}</button>
    </div>
    <div class="estado ${st.estado}" aria-live="polite">${esc(st.texto)}</div>
  </article>`;
}

/** Texto y colores del estado de una charla. */
function estadoCharla(a) {
  if (estado.guardando.has(a.id)) return { clase: 'modificada', estado: 'guardando', texto: 'Guardando…' };
  if (estado.errores.has(a.id)) {
    return { clase: 'con-error', estado: 'err', texto: 'Error: ' + estado.errores.get(a.id) + ' Toque Guardar para reintentar.' };
  }
  if (estado.borradores.has(a.id)) return { clase: 'modificada', estado: 'mod', texto: 'Cambio sin guardar' };
  if (a.asistentes != null) {
    const quien = a.registradoPor ? ' por ' + a.registradoPor : '';
    return {
      clase: 'guardada', estado: 'ok',
      texto: a.horaRegistro ? `Guardado ${a.horaRegistro}${quien}` : `Registrado: ${a.asistentes} (editado en la hoja)`
    };
  }
  return { clase: '', estado: 'sin', texto: 'Sin registrar' };
}

/** Actualiza una tarjeta sin redibujar la lista (no quita el foco del campo). */
function actualizarTarjeta(id) {
  const card = document.getElementById('c-' + id);
  const a = estado.salon && estado.salon.actividades.find((x) => x.id === id);
  if (!card || !a) return;
  const st = estadoCharla(a);
  card.className = 'charla ' + st.clase;
  const est = card.querySelector('.estado');
  est.className = 'estado ' + st.estado;
  est.textContent = st.texto;
  const inp = card.querySelector('input');
  if (!estado.borradores.has(id) && document.activeElement !== inp) inp.value = a.asistentes == null ? '' : String(a.asistentes);
  const btn = card.querySelector('[data-guardar]');
  btn.disabled = !estado.salon.puedeGuardar || estado.guardando.has(id);
  btn.textContent = estado.guardando.has(id) ? '…' : 'Guardar';
}

function actualizarResumen() {
  const acts = actividadesDelDia();
  const reg = acts.filter((a) => a.asistentes != null);
  $('resTotal').textContent = reg.reduce((s, a) => s + a.asistentes, 0).toLocaleString('es-CR');
  $('resCharlas').textContent = `${reg.length} / ${acts.length}`;
  $('resBarra').style.width = (acts.length ? Math.round((reg.length / acts.length) * 100) : 0) + '%';
  const ids = new Set(estado.salon ? estado.salon.actividades.map((a) => a.id) : []);
  const n = [...estado.borradores.keys()].filter((id) => ids.has(id)).length;
  const errores = [...estado.errores.keys()].filter((id) => ids.has(id)).length;
  $('dockSum').innerHTML = n
    ? `<b>${n} cambio${n === 1 ? '' : 's'} sin guardar</b>${errores ? errores + ' con error · toque para reintentar' : 'Toque Guardar todo'}`
    : `<b>Todo guardado</b>${esc(estado.dia || '')}: ${reg.length} de ${acts.length} charlas registradas`;
  const btn = $('btnGuardarTodo');
  btn.textContent = n ? `Guardar todo (${n})` : 'Guardar todo';
  renderBurbujas();
  btn.disabled = !n || !(estado.salon && estado.salon.puedeGuardar);
  $('barraGuardarTodo').hidden = !acts.length || !(estado.salon && estado.salon.puedeGuardar);
}

/** Actualiza solo las burbujas de cambios sin guardar de las pestañas (sin redibujarlas). */
function renderBurbujas() {
  const r = estado.salon;
  if (!r) return;
  document.querySelectorAll('#tabsDias .tab-dia').forEach((b) => {
    const pend = r.actividades.filter((a) => norm(a.dia) === norm(b.dataset.dia) && estado.borradores.has(a.id)).length;
    let bdg = b.querySelector('.bdg');
    if (!pend) { if (bdg) bdg.remove(); return; }
    if (!bdg) { bdg = document.createElement('span'); bdg.className = 'bdg'; bdg.title = 'Cambios sin guardar'; b.prepend(bdg); }
    bdg.textContent = pend;
  });
  const sel = r.actividades.filter((a) => a.asistentes != null);
  document.querySelectorAll('#tabsDias .tab-dia:not(:disabled) small').forEach((sm) => {
    const dia = sm.closest('.tab-dia').dataset.dia;
    const acts = r.actividades.filter((a) => norm(a.dia) === norm(dia));
    const reg = sel.filter((a) => norm(a.dia) === norm(dia)).length;
    const hoy = sm.querySelector('.hoy');
    sm.innerHTML = (hoy ? hoy.outerHTML : '') + `${reg} de ${acts.length}`;
  });
}

function reemplazarActividad(nueva) {
  const lista = estado.salon && estado.salon.actividades;
  if (!lista) return;
  const i = lista.findIndex((a) => a.id === nueva.id);
  if (i >= 0) lista[i] = nueva;
}

/** Registra lo escrito en un campo (solo dígitos). */
function alEscribir(inp) {
  const limpio = inp.value.replace(/\D+/g, '').slice(0, 6);
  if (limpio !== inp.value) inp.value = limpio;
  const id = inp.dataset.id;
  const a = estado.salon.actividades.find((x) => x.id === id);
  const guardado = a && a.asistentes != null ? String(a.asistentes) : '';
  if (limpio === guardado) estado.borradores.delete(id); else estado.borradores.set(id, limpio);
  estado.errores.delete(id);
  actualizarTarjeta(id);
  actualizarResumen();
}

async function guardarUno(id) {
  if (!estado.salon || !estado.salon.puedeGuardar || estado.guardando.has(id)) return;
  const inp = document.querySelector(`#c-${CSS.escape(id)} input`);
  const valor = estado.borradores.has(id) ? estado.borradores.get(id) : (inp ? inp.value.trim() : '');
  if (valor === '') {
    estado.errores.set(id, 'Escriba la cantidad de asistentes.');
    return actualizarTarjeta(id);
  }
  estado.guardando.add(id);
  estado.errores.delete(id);
  actualizarTarjeta(id);
  try {
    const r = await apiOk('guardarAsistencia', { id, valor, token: tokenSalon() });
    reemplazarActividad(r.actividad);
    if (estado.borradores.get(id) === valor || !estado.borradores.has(id)) estado.borradores.delete(id);
  } catch (e) {
    estado.errores.set(id, e.message);
    if (!estado.borradores.has(id)) estado.borradores.set(id, valor); // conservar el número
  } finally {
    estado.guardando.delete(id);
    actualizarTarjeta(id);
    actualizarResumen();
  }
}

async function guardarTodo() {
  if (!estado.salon || !estado.salon.puedeGuardar) return;
  const ids = new Set(estado.salon.actividades.map((a) => a.id));
  const items = [];
  [...estado.borradores.entries()].forEach(([id, valor]) => {
    if (!ids.has(id) || estado.guardando.has(id)) return;
    if (valor === '') { estado.errores.set(id, 'Escriba la cantidad de asistentes.'); actualizarTarjeta(id); return; }
    items.push({ id, valor });
  });
  if (!items.length) return;
  const btn = $('btnGuardarTodo');
  btn.disabled = true; btn.textContent = 'Guardando…';
  items.forEach((it) => { estado.guardando.add(it.id); estado.errores.delete(it.id); actualizarTarjeta(it.id); });
  let ok = 0; let mal = 0;
  try {
    const r = await api('guardarLote', { items, token: tokenSalon() });
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
    items.forEach((it) => { estado.guardando.delete(it.id); actualizarTarjeta(it.id); });
    actualizarResumen();
  }
  if (mal) toast(`${ok} guardado(s), ${mal} con error. Revise las tarjetas en rojo.`, 'err');
  else toast(`${ok} registro(s) guardado(s).`, 'ok');
}

// ---------------------------------------------------------------------------
//  Pantalla 5: administrador
// ---------------------------------------------------------------------------
const adm = { borradores: new Map(), errores: new Map(), guardando: new Set() };

async function mostrarAdmin() {
  const ses = Sesion.admin();
  if (!ses) return mostrarPin(null);
  mostrarVista('vAdmin', 'Administración', 'Totales, charlas sin registrar, correcciones y bitácora.', true);
  mostrarError('errorAdmin', '');
  if (estado.admin) renderAdmin(); else cargando(true);
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
  } finally {
    cargando(false);
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
    if (estado.inicio) estado.inicio.bloqueo = r.bloqueo;
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

  $('btnVolver').addEventListener('click', () => {
    if (estado.vista === 'vSalon' && estado.borradores.size &&
      !confirm('Hay números sin guardar. ¿Salir de todos modos? (Se conservan si vuelve a este salón.)')) return;
    ir('#/');
  });
  $('btnSalir').addEventListener('click', () => {
    if (hayBorradores() && !confirm('Hay números sin guardar. ¿Cerrar la sesión de todos modos?')) return;
    Sesion.borrarTodo();
    estado.salon = null; estado.salonClave = null; estado.admin = null; estado.bitacora = null;
    estado.borradores.clear(); estado.errores.clear(); adm.borradores.clear(); adm.errores.clear();
    ir('#/');
  });

  $('gridSalones').addEventListener('click', (e) => {
    const b = e.target.closest('[data-salon]');
    if (b) ir(hashSalon(b.dataset.salon));
  });
  $('btnAdmin').addEventListener('click', () => ir('#/admin'));
  $('formPin').addEventListener('submit', enviarPin);

  // Pestañas de días
  $('tabsDias').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dia]');
    if (!b || b.disabled) return;
    estado.dia = b.dataset.dia;
    history.replaceState(null, '', hashSalon(estado.salon.salon, estado.dia));
    renderSalon();
    window.scrollTo(0, 0);
  });

  // Tarjetas de charlas
  const lista = $('listaActividades');
  lista.addEventListener('input', (e) => { if (e.target.matches('input[data-id]')) alEscribir(e.target); });
  lista.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input[data-id]')) { e.preventDefault(); guardarUno(e.target.dataset.id); }
  });
  lista.addEventListener('click', (e) => {
    const b = e.target.closest('[data-guardar]');
    if (b) guardarUno(b.dataset.guardar);
  });
  // Si llegaron datos nuevos mientras escribía, se redibuja al salir del campo.
  lista.addEventListener('focusout', () => {
    setTimeout(() => { if (estado.renderPendiente && !escribiendo() && estado.vista === 'vSalon') renderSalon(); }, 400);
  });
  $('btnRecargar').addEventListener('click', () => { mostrarError('errorSalon', ''); cargando(true); cargarSalon(false); });
  $('btnGuardarTodo').addEventListener('click', guardarTodo);

  // Administrador
  $('admRecargar').addEventListener('click', () => { estado.bitacora = null; cargando(true); cargarAdmin(false); });
  $('admBloqueo').addEventListener('click', alternarBloqueo);
  $('admCsv').addEventListener('click', exportarCsv);
  document.querySelector('.tabs-admin').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    estado.admTab = b.dataset.tab;
    renderAdmin();
    if (estado.admTab === 'bitacora') cargarBitacora();
  });
  ['fDia', 'fSalon', 'fEstado', 'fSinRegistrar'].forEach((id) => $(id).addEventListener('change', renderAdmin));
  let tBuscar = null;
  $('fTexto').addEventListener('input', () => { clearTimeout(tBuscar); tBuscar = setTimeout(renderAdmin, 250); });
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
  if (estado.vista === 'vSalon' && estado.salon) cargarSalon(true);
  else if (estado.vista === 'vAdmin' && estado.admin) cargarAdmin(true);
}

document.addEventListener('DOMContentLoaded', iniciar);
