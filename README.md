# Registro de asistencia por charla — CMN 2026

Sistema web para que los encargados de cada salón del **Congreso Médico Nacional 2026** registren desde el celular o la tablet cuántas personas asistieron a cada charla.

- **Base de datos:** una hoja de Google Sheets (el archivo `BD_Asistencia_CMN2026.xlsx` convertido).
- **Servidor:** Google Apps Script vinculado a esa hoja (`Code.gs`).
- **Página web:** `index.html`, `styles.css` y `app.js`, publicados gratis en GitHub Pages.

Todo lo que usted cambie en la hoja (charlas, expositores, correos, horas, PINes, estado) se ve en el sistema al recargar la página. No hace falta tocar código.

---

## Contenido

1. [Subir el Excel a Google Drive y convertirlo](#1-subir-el-excel-a-google-drive-y-convertirlo)
2. [Poner los PINes y revisar la configuración](#2-poner-los-pines-y-revisar-la-configuración)
3. [Pegar el código en Apps Script](#3-pegar-el-código-en-apps-script)
4. [Publicar el Apps Script como aplicación web](#4-publicar-el-apps-script-como-aplicación-web)
5. [Publicar la página en GitHub Pages](#5-publicar-la-página-en-github-pages)
6. [Uso diario: cambios desde la hoja](#6-uso-diario-cambios-desde-la-hoja)
7. [Si cambia el código: publicar una nueva versión](#7-si-cambia-el-código-publicar-una-nueva-versión)
8. [Cómo se usa (encargados y administrador)](#8-cómo-se-usa)
9. [Problemas frecuentes](#9-problemas-frecuentes)
10. [Seguridad y privacidad](#10-seguridad-y-privacidad)
11. [Pruebas (para personal técnico)](#11-pruebas-para-personal-técnico)

---

## 1. Subir el Excel a Google Drive y convertirlo

1. Entre a <https://drive.google.com> con la cuenta de Google que va a administrar el sistema.
2. Clic en **Nuevo → Subir archivo** y elija `BD_Asistencia_CMN2026.xlsx`.
3. Cuando termine de subir, haga doble clic sobre el archivo. Se abre una vista previa.
4. Arriba, clic en **Abrir con → Hojas de cálculo de Google**.
5. Ya dentro de la hoja: **Archivo → Guardar como Hojas de cálculo de Google**. Se crea una copia convertida (con el ícono verde de Sheets). **Trabaje siempre en esa copia.** Puede borrar el `.xlsx` de Drive para no confundirse.
6. En la hoja convertida: **Archivo → Configuración → Zona horaria:** elija **(GMT-06:00) Costa Rica** y guarde.

Debe tener 4 pestañas: `Actividades`, `Salones`, `Config` y `Bitacora`. No les cambie el nombre.

## 2. Poner los PINes y revisar la configuración

### Hoja `Salones`

| Salon | PIN_encargado | Encargado | Activo |
|---|---|---|---|
| Real 1 | 4821 | Ana Pérez | TRUE |

- En el archivo original todos los PINes dicen **`CAMBIAR`**. Mientras un salón tenga `CAMBIAR` (o esté vacío) **nadie puede entrar a ese salón**. Ponga un PIN distinto para cada salón.
- Consejo: seleccione la columna `PIN_encargado` y use **Formato → Número → Texto sin formato** antes de escribir los PINes. Así un PIN como `0123` no pierde el cero (de todas formas el sistema lo tolera).
- `Activo`: si lo pone en `FALSE` (desmarca la casilla), el salón desaparece de la pantalla de inicio.
- El orden de las tarjetas en la pantalla de inicio es el orden de las filas de esta hoja.

### Hoja `Config`

| Clave | Valor | Para qué sirve |
|---|---|---|
| `PIN_admin` | (su PIN) | PIN del administrador. Entra al panel y a cualquier salón. Cámbielo: con `CAMBIAR` no funciona. |
| `Evento` | Congreso Médico Nacional 2026 | Título que se ve arriba. |
| `Dias` | Lunes,Martes,Miércoles,Jueves,Viernes | Días que se muestran como botones. |
| `Bloquear_edicion` | NO | `SI` = los encargados solo pueden ver. Se puede cambiar también desde el panel. |
| `Fecha_inicio` | 9/11/2026 *(ejemplo)* | **Fila nueva, recomendada.** Fecha del lunes del congreso. |

> **Importante — agregue la fila `Fecha_inicio`.** El Excel no trae las fechas reales del congreso, solo los nombres de los días. Con esta fila el sistema sabe qué día es "hoy" (para abrir ese día por defecto) y qué charlas "ya pasaron y no tienen asistencia". Si no la agrega, el sistema asume que el congreso es **la semana en curso**, lo cual solo es correcto durante la semana del congreso.
> Escriba en la columna A `Fecha_inicio` y en la B la fecha del lunes (por ejemplo `9/11/2026`, que Sheets reconoce como fecha).

## 3. Pegar el código en Apps Script

1. En la hoja convertida: **Extensiones → Apps Script**. Se abre el editor en otra pestaña.
2. A la izquierda verá un archivo `Código.gs` con unas líneas de ejemplo. Bórrelas todas.
3. Abra el archivo [`Code.gs`](Code.gs) de este repositorio, copie **todo** su contenido y péguelo en el editor.
4. Clic en el ícono de disquete (**Guardar proyecto**). Si quiere, cambie el nombre del proyecto arriba a la izquierda (por ejemplo "API Asistencia CMN 2026").
5. **Autorizar** (solo la primera vez): arriba, en la lista de funciones, elija `probarLectura` y clic en **▶ Ejecutar**.
   - Google pedirá permisos: **Revisar permisos →** elija su cuenta.
   - Si aparece "Google no ha verificado esta aplicación": clic en **Configuración avanzada → Ir a (nombre del proyecto) (no seguro)** → **Permitir**. Es normal: el script es suyo.
   - Abajo, en el **Registro de ejecución**, deben aparecer los salones con su número de charlas. Si sale un error, revise el nombre de las pestañas.

## 4. Publicar el Apps Script como aplicación web

1. En el editor de Apps Script, arriba a la derecha: **Implementar → Nueva implementación**.
2. Junto a "Seleccionar tipo", clic en el engranaje ⚙ → **Aplicación web**.
3. Llene así:
   - **Descripción:** `Versión 1`
   - **Ejecutar como:** **Yo** (su correo)
   - **Quién tiene acceso:** **Cualquier persona**
4. Clic en **Implementar**. (Si vuelve a pedir permisos, acéptelos como en el paso anterior.)
5. Copie la **URL de la aplicación web**. Termina en `/exec`, algo así:
   `https://script.google.com/macros/s/AKfycb.../exec`
6. Pruebe: pegue la URL en el navegador y agregue al final `?accion=getSalones`. Debe ver un texto que empieza con `{"ok":true,"evento":"Congreso Médico Nacional 2026"...`.

> "Cualquier persona" significa que la página puede hablar con el script sin iniciar sesión en Google. Los datos siguen protegidos por los PINes: sin un PIN válido solo se ve la lista de salones y su avance.

## 5. Publicar la página en GitHub Pages

1. En GitHub, abra este repositorio y el archivo **`app.js`**. Clic en el lápiz ✏ (**Edit this file**).
2. En la línea que dice
   ```js
   const API_URL = 'PEGUE_AQUI_LA_URL_DE_SU_APPS_SCRIPT';
   ```
   reemplace el texto entre comillas por la URL que copió en el paso 4 (deje las comillas).
3. Clic en **Commit changes…** → **Commit changes**.
4. Vaya a **Settings → Pages**:
   - **Source:** Deploy from a branch
   - **Branch:** `main` y carpeta `/ (root)` → **Save**.
5. Espere 1–2 minutos. Arriba de esa misma página aparecerá la dirección, del tipo
   `https://<su-usuario>.github.io/cmn2026/`
6. Ábrala en el celular. Esa es la dirección que les pasa a los encargados (puede convertirla en un código QR).

> Si los archivos están en otra rama (por ejemplo la rama donde se desarrolló), primero únalos a `main` (Pull request → Merge) o elija esa rama en el paso 4.

## 6. Uso diario: cambios desde la hoja

Todo se cambia **en la hoja**; en el celular basta tocar **↻ Recargar** (o esperar: la vista se actualiza sola cada 60 segundos).

- **Cambiar un PIN:** hoja `Salones`, columna `PIN_encargado`. Quien estaba adentro con el PIN viejo tendrá que volver a entrar.
- **Agregar o corregir un correo:** hoja `Actividades`, columna `Correo`. Si hay varios expositores, separe con ` / ` en el mismo orden que en `Expositor` (ej.: `ana@x.com / juan@y.com`). Si la cantidad de correos no coincide con la de expositores, el sistema no adivina a quién pertenece cada uno y los muestra aparte como "Correos: …".
- **Confirmar un expositor pendiente:** escriba el nombre en `Expositor`, el código en `Codigo_medico` y cambie `Estado` a `CONFIRMADO`.
- **Agregar una charla:** agregue una fila al final de `Actividades` con:
  - `ID` nuevo y único, siguiendo la numeración (ej.: `ACT-0528`). **Nunca repita ni reutilice un ID.**
  - `Dia` escrito igual que en `Config → Dias` (ej.: `Miércoles`).
  - `Salon` escrito igual que en la hoja `Salones`.
  - `Hora` como las demás, ej.: `9:00 - 9:20 a.m.` o `1:30 - 1:50 p.m.`
  - `Orden`: un número (desempata charlas a la misma hora).
  - `Entidad`, `Simposio`, `Charla`, `Expositor`, `Codigo_medico`, `Correo`, `Estado`.
  - Deje vacías `Asistentes`, `Registrado_por` y `Fecha_registro`.
- **Quitar una charla:** borre su fila completa.
- **Mover o agregar columnas:** se puede. El sistema busca las columnas por el nombre del encabezado, así que **no cambie los nombres** de los encabezados.
- **Corregir un número de asistencia:** mejor hágalo desde el panel de administrador (queda en la bitácora). Si lo cambia directo en la hoja también funciona, pero no queda registro en la bitácora y en el celular aparecerá como "editado en la hoja".

El sistema **solo escribe** en `Asistentes`, `Registrado_por`, `Fecha_registro`, en la hoja `Bitacora` y en `Config → Bloquear_edicion`. Nunca modifica las demás columnas.

## 7. Si cambia el código: publicar una nueva versión

Cada vez que modifique `Code.gs` en el editor de Apps Script, los cambios **no se aplican** hasta publicar una nueva versión:

1. Guarde (disquete).
2. **Implementar → Gestionar implementaciones**.
3. Seleccione su implementación y clic en el lápiz ✏ (**Editar**).
4. En **Versión**, elija **Nueva versión** → **Implementar**.

La URL se mantiene igual, así que no hay que tocar `app.js`.
⚠ **No use "Nueva implementación"** para actualizar: eso crea una URL distinta y la página dejaría de funcionar hasta que cambie `API_URL`.

Si cambia `index.html`, `styles.css` o `app.js` en GitHub, GitHub Pages se actualiza solo en 1–2 minutos (en el celular puede requerir recargar).

## 8. Cómo se usa

**Encargado de salón**
1. Abre la página, toca su salón y escribe el PIN. No hay que volver a escribirlo mientras no cierre la pestaña.
2. Se abre el día de hoy (si su salón tiene charlas ese día). Los días sin charlas aparecen en gris.
3. Cada charla tiene un campo grande: escribe el número y toca **Guardar**. Queda en verde: "Guardado 10:42 a.m. por Real 1".
4. Si no hay señal, la tarjeta se pone en rojo, **el número se conserva** y puede tocar **Guardar** otra vez para reintentar. También puede llenar varias y usar **Guardar todo**.
5. Si se equivocó, cambie el número y guarde de nuevo: se permite, y queda en la bitácora.

**Administrador** (botón discreto "Administrador" al pie de la pantalla de inicio)
- **Totales** por día, por salón y por simposio, más el total general. Respetan los filtros.
- **Charlas**: tabla completa con filtros (día, salón, estado, "solo sin registrar", búsqueda). Puede corregir cualquier número; dejar el campo vacío y guardar borra el registro.
- **Sin registrar y ya pasaron**: la lista para perseguir a los encargados.
- **Bitácora**: todos los cambios, del más reciente al más antiguo.
- **Exportar CSV**: descarga lo que está viendo (con los filtros aplicados).
- **Bloquear / Desbloquear edición** y **Abrir Google Sheet**.
- Con el PIN de administrador también puede entrar a cualquier salón como si fuera el encargado.

## 9. Problemas frecuentes

| Síntoma | Qué hacer |
|---|---|
| Barra roja "Falta configurar la URL del Apps Script" | Falta el paso 5 (poner la URL en `app.js`). |
| "Respuesta inesperada del servidor" | La implementación no tiene acceso "Cualquier persona", o la URL no es la que termina en `/exec`. |
| "El salón X no tiene PIN configurado" | En `Salones` el PIN sigue en `CAMBIAR` o vacío. |
| "Demasiados intentos con PIN incorrecto" | Tras 15 PINes errados seguidos en un salón, el ingreso a ese salón se pausa 5 minutos. Quien ya estaba adentro sigue trabajando normalmente. |
| "El PIN cambió. Vuelva a ingresarlo." | Se cambió el PIN en la hoja; el encargado debe ingresar el nuevo. |
| "Falta la columna … en la hoja …" | Se renombró o borró un encabezado. Restáurelo. |
| El día de "hoy" no se selecciona o la lista de atrasadas está rara | Revise `Config → Fecha_inicio` (paso 2). |
| Hice cambios en `Code.gs` y no se ven | Publique una nueva versión (paso 7). |

## 10. Seguridad y privacidad

- Los PINes se validan **en el servidor**; la página nunca recibe la lista de PINes. Al entrar, el servidor entrega una sesión firmada que dura 18 horas y solo sirve para ese salón.
- Un encargado solo puede guardar en las charlas de **su** salón: el servidor rechaza cualquier otra.
- Todas las escrituras usan `LockService`, así que varios encargados pueden guardar a la vez sin pisarse.
- **No suba el Excel ni datos de expositores a este repositorio**: el repositorio de GitHub Pages es público. El archivo `.gitignore` ya excluye los `.xlsx`.
- Use PINes distintos por salón y un PIN de administrador largo (6 dígitos o más).

## 11. Pruebas (para personal técnico)

La carpeta `pruebas/` contiene un simulador de Apps Script en Node.js que ejecuta `Code.gs` real contra los datos del Excel, más una prueba de la interfaz en un navegador (Playwright).

```bash
pip install openpyxl
python3 pruebas/xlsx_a_json.py BD_Asistencia_CMN2026.xlsx pruebas/datos_prueba.json
node pruebas/test_backend.js                         # 27 pruebas de la lógica del servidor
NODE_PATH=$(npm root -g) node pruebas/test_ui.js     # requiere playwright instalado
```

Entre otras cosas verifican: que Roble 2 el martes muestra sus 4 simposios en orden, que una charla PENDIENTE se ve con su etiqueta y se puede registrar, que el PIN de otro salón es rechazado, que un encargado no puede guardar en otro salón, que se interpretan los 52 formatos de hora distintos del Excel y que el sistema sigue funcionando si se mueven columnas o filas.
