# Autorización de Notas de Crédito — v1.1 (vía RESTlet)

**BATAB · 24-ago-2026 · Dirección General**
Sustituye la vía de escritura documentada en `README_Autorizacion_Notas_Credito.md` (v1.0, 06-ago-2026).
Todo lo demás de aquel documento —política del carril, campos, consulta del Director— sigue vigente.

---

## 1. Qué se rompió

El 24-ago-2026, al intentar autorizar **CM3958** (id 218366, CONSTRUCTORA PECED,
$15,798, sin timbrar) desde la app del Director, NetSuite respondió:

```
400 Bad Request
o:errorCode: USER_ERROR
detail: "Error while accessing a resource.
         Este registro ha sido bloqueado por un flujo de trabajo definido por el usuario."
```

## 2. Diagnóstico

Hay un **workflow de NetSuite con acción "Bloquear registro"** sobre la nota de
crédito. Se activa mientras la NC está pendiente de autorización, es decir:

    custbody_requiere_autorizacion = T   Y   custbody_nc_autorizado = F

Ese candado aplica a **todo acceso externo**, no solo a la escritura. Se comprobó
que con rol de administrador ni siquiera se puede **leer** el registro:

```
GET /services/rest/record/v1/creditmemo/218366  ->  mismo error 400
```

Evidencia comparativa del día del diagnóstico:

| NC | marcada | autorizado | ¿Responde REST? |
|---|---|---|---|
| CM3958 (218366) | T | F | **NO — bloqueada** |
| CM3952 (204699), CM3953 (206010) | T | T | Sí |
| CM3959, CM3957, CM3956, CM3955, CM3954 | F | — | Sí |
| CM3763 (136987, sin timbrar) | F | F | Sí |

El candado correlaciona exactamente con el estado *pendiente de autorización*.

**Por eso el 19-ago sí funcionó:** CM3935, CM3936 y CM3951 entraron al carril por
el artículo 1555, nunca estuvieron marcadas, nunca cayeron en el estado bloqueado.
CM3958 fue la primera NC que realmente entró a él.

CM3952 y CM3953 sí quedaron autorizadas, pero **no por la app** (no hay rastro en
`netsuite_trace_log`): se aprobaron desde la pantalla de NetSuite, con el botón
del propio workflow. Los workflows escriben sobre registros que ellos mismos
bloquearon; la API no.

## 3. El nudo

Círculo cerrado: el workflow bloquea la NC hasta que Dirección autorice, pero la
única forma de autorizar desde fuera es escribir el campo… que está bloqueado.

**Decisión de Dirección (24-ago-2026): conservar el candado.** Es el freno duro al
timbrado que el User Event `bat_nc_bloqueo_timbrado` nunca llegó a garantizar
(riesgo de `ignoreUserEvents` del bundle MySuite). Se cambia la vía de escritura,
no el control.

## 4. Solución: escribir por SuiteScript

El candado del workflow **no aplica a SuiteScript en servidor**. La escritura del
sello se enruta ahora por un RESTlet dedicado.

Se dejó como script **aparte** del `BATAB - Ensambles RESTlet` (script 2726) a
propósito: aquél maneja Fase 2 de producción y no se toca por un cambio de
facturación.

### 4.1 RESTlet `bat_nc_autorizar` v1.0.0

Archivo: `bat_nc_autorizar_v1.0.js` (en esta misma carpeta)

| Parámetro | Valor |
|---|---|
| ID de script | `customscript_bat_nc_autorizar` |
| ID de despliegue | `customdeploy_bat_nc_autorizar` |
| Tipo | RESTlet (SuiteScript 2.1) |
| Ejecutar como | Administrador |
| Estado | Publicado / Liberado |
| Audiencia | incluir **BAT: Rol integrador Netsuite** |

**Los IDs importan.** La edge function arma la URL con esas cadenas, no con ids
internos numéricos. Si NetSuite les asigna otro nombre, hay que ajustar las
variables de entorno `NS_RL_NC_SCRIPT` / `NS_RL_NC_DEPLOY` en Supabase.

Contrato:

```json
POST { "action": "autorizar" | "rechazar" | "ping",
       "ncId": 218366, "motivo": "", "dry_run": false }
```

Escribe con `record.submitFields`; si eso falla, reintenta con `record.load` +
`save`. La respuesta dice cuál de las dos funcionó, en el campo `metodo` — dato
clave para diagnosticar si algún día NetSuite endurece el candado.

Valida por su cuenta (no confía en el llamador): carril, idempotencia, y avisa si
la NC ya trae UUID.

### 4.2 Edge function `aprobar-nota-credito` v1.1

- Proyecto Supabase: `szrcmvlgxxpmvgrfmxak`
- URL: `https://szrcmvlgxxpmvgrfmxak.supabase.co/functions/v1/aprobar-nota-credito`
- `verify_jwt: false`

**Lectura**: sigue por SuiteQL, que nunca se vio afectada por el candado.

**Escritura**: orden de intento

1. RESTlet `bat_nc_autorizar` — vía normal, libra el candado
2. `PATCH /record/v1/creditMemo/{id}` — respaldo; sirve para NC no bloqueadas y
   mantiene el flujo vivo si el RESTlet se cae o se despliega mal

La respuesta indica cuál vía se usó, en el campo `via`, y queda registrado en
`netsuite_trace_log`.

**Sonda de salud**: `POST {"ping": true}` responde si el RESTlet está vivo.
Úsala antes de sospechar de otra cosa.

### 4.3 App del Director v3.9.1

- Commit: `c899967` · `APP_VERSION = '2026-08-24-nc-restlet'`
- Nueva función `explicarErrorNC()`: traduce el volcado JSON de NetSuite a un
  mensaje operativo. Cubre candado de workflow, RESTlet no desplegado, NC fuera
  del carril y NC anulada.

## 5. Prueba de aceptación

Pendiente al momento de escribir esto. Con el RESTlet desplegado:

1. `POST {"ping":true}` a la edge function → debe responder `ok: true`.
2. Autorizar **CM3958** desde el Director → debe pasar y devolver `via: "restlet"`.
3. Confirmar en NetSuite que `custbody_nc_autorizado` quedó palomeado y que
   María Isabel ya puede timbrar.

Si el paso 2 falla con `metodo: "ninguno"`, entonces el candado del workflow
también alcanza a SuiteScript en esta cuenta y hay que replantear: quitar la
acción "Bloquear registro" y controlar el timbrado por permisos de rol.

## 6. Riesgo abierto

Nadie documentó ese workflow cuando se creó. **Conviene ubicarlo** en
Personalización → Flujo de trabajo → Flujos de trabajo, filtrando por tipo de
registro *Nota de crédito*, y anotar aquí su nombre e id. Mientras no se sepa
cuál es, cualquier cambio que haga el consultor sobre él vuelve a romper el
carril sin aviso.
