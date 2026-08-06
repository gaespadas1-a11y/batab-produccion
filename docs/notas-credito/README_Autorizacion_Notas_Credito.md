# BATAB — Autorización de Notas de Crédito

**Versión del paquete:** 1.0
**Fecha:** 06-ago-2026
**Autorizado por:** Dirección General (Gerardo Espadas Hernández)
**Cuenta NetSuite:** 7905968 · Subsidiaria 2 (BLOQUES Y AGREGADOS DE TABASCO)

---

## 1. Problema que resuelve

NetSuite **no tiene flujo de aprobación nativo para notas de crédito de cliente**. El campo
`approvalstatus` queda siempre en `null` en las transacciones tipo `CustCred` — se verificó
sobre las 242 NC emitidas en 2026 y ninguna tiene valor. Por eso las notas de crédito con
descuento se emitían y se timbraban sin pasar por Dirección.

El consultor dejó en productivo la búsqueda guardada
`customsearch_batab_aprob_nota_credito` ("BATAB | Aprobación de nota credito"), pero
regresaba cero registros porque dependía de banderas que nadie encendía.

Este paquete cierra el ciclo: la NC aparece en la App del Director igual que las órdenes
de compra y las transferencias, y el timbrado queda bloqueado hasta que Dirección autoriza.

---

## 2. Mecanismo de control

No se usa `approvalstatus`. Se usan dos campos personalizados que ya existían en el
registro de nota de crédito:

| Campo | Etiqueta | Quién lo mueve |
|---|---|---|
| `custbody_requiere_autorizacion` | Requiere autorización | Capturista (Ma. Isabel / Comercial), al capturar |
| `custbody_nc_autorizado` | Autorizado | Dirección, desde la App del Director |

Campo auxiliar usado en el rechazo: `custbodycustbody_bat_observaciones`
("Observaciones del revisor") — ahí queda escrito el motivo.

### Carril de autorización (política DG 06-ago-2026)

Entra a autorización toda NC que cumpla **cualquiera** de estas dos:

1. Contiene el artículo **1555 — DESCUENTO/BONIFICACION S/VENTAS** (detección automática), o
2. Viene marcada con "Requiere autorización" (solicitud explícita del capturista).

Quedan fuera, sin fricción: amortizaciones de anticipo, ajustes de centavos (artículo 1210)
y devoluciones ordinarias.

**Sin tope de importe.** Dirección aprueba con criterio propio, igual que en
`aprobar-oc-general`.

---

## 3. Componentes desplegados

### 3.1 Edge function `aprobar-nota-credito` v1.0

- Proyecto Supabase: `szrcmvlgxxpmvgrfmxak`
- URL: `https://szrcmvlgxxpmvgrfmxak.supabase.co/functions/v1/aprobar-nota-credito`
- `verify_jwt: false` (igual que `aprobar-oc` / `aprobar-oc-general`)
- Fuente: `aprobar-nota-credito_v1.0.ts` (en esta misma carpeta)

**Request**

```json
{ "ncId": "203758", "accion": "aprobar", "motivo": "", "dry_run": false }
```

- `accion`: `aprobar` (default) o `rechazar`
- `motivo`: solo en rechazo; se escribe en Observaciones del revisor
- `dry_run`: valida y responde sin escribir en NetSuite

**Escritura en NetSuite** — `PATCH /services/rest/record/v1/creditMemo/{id}`

- Aprobar: `{ custbody_nc_autorizado: true, custbody_requiere_autorizacion: false }`
- Rechazar: `{ custbody_nc_autorizado: false, custbody_requiere_autorizacion: false, custbodycustbody_bat_observaciones: "RECHAZADA POR DIRECCION: ..." }`

**Validaciones**

1. Debe ser `CustCred` (no factura, no otro tipo)
2. No anulada (`voided = F`)
3. Debe estar dentro del carril (descuento o marcada); si no, responde 403
4. Idempotente: si ya está autorizada, no reintenta
5. Si la NC ya trae UUID, responde con `advertencia`: el sello es posterior al CFDI

Todo queda registrado en `netsuite_trace_log` con eventos `nc_autorizada`,
`nc_rechazada`, `nc_rechazo_validacion`.

### 3.2 App del Director v3.9.0

- Repo: `gaespadas1-a11y/batab-produccion`, archivo `director.html`
- URL: `https://gaespadas1-a11y.github.io/batab-produccion/director.html`
- Commit de esta versión: `7dd7581`
- `APP_VERSION = '2026-08-06-nc'` (candado de auto-actualización)

Nueva sección **"Notas de crédito"**, debajo de "Otras órdenes de compra". Funciones
agregadas: `cargarNCs()`, `renderNCs()`, `aprobarNC()`, `rechazarNC()`.

Consulta que alimenta la sección (SuiteQL vía `netsuite-proxy`):

```sql
SELECT t.id, t.tranid, BUILTIN.DF(t.entity) AS cliente, ABS(t.foreigntotal) AS total,
       t.memo, TO_CHAR(t.trandate,'DD/MM/YYYY') AS fecha,
       t.custbody_mx_cfdi_uuid AS uuid,
       NVL(t.custbody_requiere_autorizacion,'F') AS marcada,
       (SELECT NVL(SUM(ABS(tl.foreignamount)),0) FROM transactionline tl
         WHERE tl.transaction=t.id AND tl.item=1555) AS descuento
FROM transaction t
WHERE t.type='CustCred' AND t.voided='F'
  AND NVL(t.custbody_nc_autorizado,'F')='F'
  AND t.trandate >= TO_DATE('2026-07-01','YYYY-MM-DD')
  AND ( NVL(t.custbody_requiere_autorizacion,'F')='T'
        OR EXISTS (SELECT 1 FROM transactionline tl2
                    WHERE tl2.transaction=t.id AND tl2.item=1555) )
ORDER BY t.trandate DESC, t.id DESC
```

Constante `NC_DESDE = '2026-07-01'` — fecha de corte. Subirla cuando el histórico
esté sellado, para que la lista solo muestre operación viva.

Señales visuales de la tarjeta:

- Borde morado + "Sin timbrar — el timbrado espera tu autorización"
- Borde ámbar + "Ya timbrada (UUID emitido) — tu sello queda posterior al CFDI"
- Badge morado `DESCUENTO $x` · Badge azul `SOLICITADA`

### 3.3 User Event `bat_nc_bloqueo_timbrado.js` v1.0

Es la única pieza que convierte el sello en **freno real**. Se despliega en NetSuite
(no se puede desplegar desde Supabase ni por el conector MCP).

- Tipo: User Event Script, aplicado a **Nota de crédito**
- Ejecutar como: Administrador
- Contextos: TODOS (no limitar a User Interface — el timbrado corre desde el bundle)

Lógica: en `beforeSubmit` detecta la transición de "sin CFDI" a "con CFDI" observando
`custbody_mx_cfdi_uuid`, `custbody_mx_cfdi_sat_signature` y
`custbody_mx_cfdi_certify_timestamp`. Si en ese instante la NC está en el carril y
`custbody_nc_autorizado` es falso, lanza error y el timbrado no procede.

**Riesgo conocido y pendiente de prueba:** si el bundle de MySuite escribe el UUID con
`record.submitFields({ ignoreUserEvents: true })`, el bloqueo no se dispara. Prueba
obligatoria antes de darlo por bueno: capturar una NC con el artículo 1555, intentar
timbrarla sin autorizar y confirmar que salta el error.

**Plan B si el bundle lo brinca:** quitar el permiso de timbrar NC del rol capturista y
dejarlo en un rol que solo se active después del visto bueno de Dirección.

---

## 4. Flujo operativo

1. Comercial / Facturación captura la NC. Si trae descuento, o si marca "Requiere
   autorización", la NC entra al carril.
2. La NC aparece en la App del Director, sección Notas de crédito.
3. Dirección presiona AUTORIZAR (o Rechazar con motivo).
4. Con el campo "Autorizado" palomeado, Facturación timbra el CFDI.
5. Toda la traza queda en `netsuite_trace_log`.

---

## 5. Datos de referencia

**Artículos de descuento en el catálogo**

| ID | Nombre | Tipo | Uso |
|---|---|---|---|
| 1555 | DESCUENTO/BONIFICACION S/VENTAS | Service | **El del carril** |
| 1210 | DESCUENTO SOBRE VENTAS (CENTAVOS) | OthCharge | Ajustes de centavos, fuera del carril |
| 1206 | Hot Sale | Discount | Promoción, sin uso reciente |
| 1034 | DESCUENTOS SOBRE COMPRAS | OthCharge | Compras, no aplica |

**NC históricas con el artículo 1555 al 06-ago-2026** (las tres ya timbradas):

| Folio | Fecha | Cliente | Total c/IVA | Descuento |
|---|---|---|---|---|
| CM3935 | 15/07/2026 | — | $22,550.40 | $19,440 |
| CM3936 | 15/07/2026 | — | $22,330.00 | $19,250 |
| CM3951 | 31/07/2026 | DEL SUR OBRAS Y SERVICIOS SA DE CV | $105,560.00 | $91,000 |

**Búsqueda guardada del consultor:** `customsearch_batab_aprob_nota_credito`. Quedó como
respaldo de consulta en la interfaz de NetSuite; el control operativo vive en la App del
Director.

---

## 6. Cómo modificar esto en el futuro

| Quiero… | Dónde se toca |
|---|---|
| Agregar otro artículo al carril | `ITEM_DESCUENTO` en la edge function **y** el `1555` del SQL en `director.html` |
| Poner tope de importe | Bloque de validaciones de la edge function (copiar el patrón de `aprobar-oc`) |
| Mover la fecha de corte de la lista | Constante `NC_DESDE` en `director.html` |
| Cambiar quién puede solicitar | Es solo el campo "Requiere autorización" en el formulario de NC |
| Publicar cambios del Director | Editar `director.html`, subir por push a GitHub, subir `APP_VERSION` |

**Precaución:** el campo de observaciones se llama `custbodycustbody_bat_observaciones`,
con el prefijo duplicado. No es un error de dedo; así quedó creado en la cuenta.

---

## 7. Archivos de este paquete

- `README_Autorizacion_Notas_Credito.md` — este documento
- `aprobar-nota-credito_v1.0.ts` — fuente de la edge function
- `bat_nc_bloqueo_timbrado_v1.0.js` — User Event para NetSuite (pendiente de desplegar)
- `director_v3.9.0.html` — snapshot completo de la App del Director
