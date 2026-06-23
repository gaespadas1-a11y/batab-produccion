# BATAB · Sistema de Control de Cemento por Silo
## Documento maestro de arquitectura y respaldo
**Fecha de archivo:** 2026-06-23 · **Estado:** funcionando en producción

Este documento describe TODO lo construido para el control de inventario de cemento,
desde la solicitud hasta la recepción y el cierre, e incluye instrucciones de reversión
(rollback) en caso de que algo falle.

---

## 1. Arquitectura general

```
Supervisor (teléfono)
   │
   ├── App de Cemento (GitHub Pages) ─── Solicitar ───► solicitar-cemento ─► OC en NetSuite (pendiente)
   │                                └─── Registrar ───► cemento-api ─► Supabase + silo + recibo (recibir-oc) en NetSuite
   │
Director General (teléfono)
   └── App BATAB Director (GitHub Pages) ─ Aprobar OC ─► aprobar-oc ─► aprueba en NetSuite + correos MS Graph

Capas:  Frontends (GitHub Pages)  →  Edge Functions (Supabase)  →  NetSuite (libro mayor) / Supabase (físico) / MS Graph (correo)
```

Principio de conciliación:
**Existencia NetSuite − Consumo en tránsito (lotes sin Build) = Disponible real = Físico en silos**

---

## 2. URLs en producción

| Pieza | URL |
|---|---|
| App de Cemento | https://gaespadas1-a11y.github.io/batab-produccion/cemento/ |
| App BATAB Director | https://gaespadas1-a11y.github.io/batab-produccion/director.html |
| Repo GitHub | gaespadas1-a11y/batab-produccion (rama main) |

---

## 3. Edge Functions (Supabase · proyecto szrcmvlgxxpmvgrfmxak)

| Función | verify_jwt | Qué hace |
|---|---|---|
| `cemento-api` | false | GET = estado vivo (silos + existencia NetSuite + tránsito + disponible + PO). POST action=entrada = guarda en Supabase, sube el silo y crea el recibo de PO en NetSuite. Idempotente por folio; no sobre-recibe. |
| `solicitar-cemento` | false | Crea OC de cemento en NetSuite (CEMEX/HOLCIM, 30/50 t) pendiente de aprobación. |
| `aprobar-oc` | false | Aprueba una OC (approvalStatus=2) y, si es de cemento, manda correo a los 4 gerentes vía MS Graph desde ceo3@batab.mx. Flags: dry_run, solo_prueba. |
| `recibir-oc` | false | Recibe una OC (transform PO→ItemReceipt) por cantidad exacta. La usa cemento-api. |
| `sharepoint-upload` | false | Sube/lista/descarga archivos en OneDrive vía MS Graph app-only. |
| `netsuite-proxy` | false | Proxy SuiteQL/REST con OAuth a NetSuite. Lo usan cemento-api y el Director. |
| `upload-director-to-github` | false | Despliega director.html al repo de GitHub. (Ver nota de sincronización abajo.) |

Las funciones están versionadas en Supabase (cada deploy crea una versión; se puede revertir
desde el panel de Supabase → Edge Functions → historial).

---

## 4. Tablas Supabase (esquema)

```sql
create table public.silos (
  codigo text primary key, nombre text not null, linea text,
  cap numeric not null default 0, nivel numeric not null default 0,
  minimo numeric not null default 15000, grupo text,
  consumo_dia numeric default 0, ult text, updated_at timestamptz default now()
);
create table public.entregas_cemento (
  id bigint generated always as identity primary key, created_at timestamptz default now(),
  folio_remision text, proveedor_id int, proveedor_nombre text,
  item_id int, item_nombre text, pedido_proveedor text, cantidad_remision_kg numeric,
  config text, po_id text, po_tranid text, ns_item_receipt_id text, ns_status text, registrado_por text
);
create table public.entregas_cemento_unidades (
  id bigint generated always as identity primary key,
  entrega_id bigint references public.entregas_cemento(id) on delete cascade,
  silo_codigo text references public.silos(codigo),
  gross numeric, tare numeric, net numeric, sello_de text, sello_a text, vehiculo text
);
create table public.cemento_movimientos (
  id bigint generated always as identity primary key, created_at timestamptz default now(),
  silo_codigo text references public.silos(codigo),
  tipo text, origen text, cantidad_kg numeric, ref text, entrega_id bigint
);
create table public.cemento_transito (
  id bigint generated always as identity primary key,
  lote text unique, linea text, pzs numeric, kg numeric, wo_id bigint,
  built boolean default false, created_at timestamptz default now()
);
```

Silos sembrados: SILO-B1 (Besser 1, cap 50t), SILO-B2 (Besser 2, cap 50t),
SILO-CO-A (Columbia 1, cap 45t, grupo Columbia), SILO-CO-B (Columbia 2, cap 45t, grupo Columbia).
Mínimo por silo 15 t; Columbia se trata como pool (mínimo combinado 30 t).

---

## 5. Datos clave de NetSuite (cuenta 7905968, subsidiaria 2)

| Concepto | Valor |
|---|---|
| Cemento CPC-40-RS (silos) | item **1230** · proveedor CEMEX (**126**) |
| Cemento CPC-40 | item **1232** · proveedor HOLCIM (**7934**) |
| Almacén Materia Prima | location **22** |
| Unidad de compra | TONELADA (id **24**) · base = KG |
| Tarifa cemento | **4,200 / tonelada** (= 4.2 / kg) |
| Cuenta ajuste recuento físico | **1360** (COGS) · customForm 257 |
| CR producción | customrecord_batab_produccion (CR 1417); status 7 = cerrado; Build asienta consumo |

Notificación de OC de cemento (correo desde **ceo3@batab.mx**):
- Juan Manuel Paredes Alvarado — manager2batab@outlook.com
- Elías Hernández Chávez — Manager1Batab@outlook.com
- Mario Alberto Cuevas Sosa — Manager4Batab@outlook.com
- Dina Villalobos González — Payroll1Batab@outlook.com

MS Graph (app BATAB Claude): tenant ab7e797d-044d-4aa6-b259-05666d10a947,
client 15cebb63-75d1-46a5-a505-7fb48f69c345 (Mail.Send + Files.ReadWrite.All).

---

## 6. Flujo de punta a punta

1. **Solicitud** — silo bajo mínimo → supervisor aprieta Solicitar → elige proveedor y 30/50 t → `solicitar-cemento` crea la OC pendiente.
2. **Aprobación** — en BATAB Director, sección "Órdenes de compra pendientes" → Aprobar → `aprobar-oc` aprueba + (si es cemento) manda los 4 correos.
3. **Recepción** — llega la pipa → supervisor captura remisión + remolques (gross/tare/net, sellos, silo) → Registrar entrada → `cemento-api`:
   - guarda entrega + unidades + movimientos en Supabase,
   - sube el nivel del silo,
   - crea el recibo en NetSuite por la cantidad exacta (recibir-oc).
4. **Conciliación** — Existencia − Consumo en tránsito = Disponible = físico en silos.

---

## 7. ROLLBACK (cómo revertir)

### App de Cemento o Director (GitHub Pages)
La versión buena está versionada en GitHub. Para revertir:
- Opción A: en GitHub, restaurar el archivo (`cemento/index.html` o `director.html`) a un commit anterior.
- Opción B: tomar el archivo de respaldo de esta carpeta de OneDrive y volver a subirlo al repo
  (mismo nombre/ruta) para sobreescribir la versión con problemas.
- Commit "bueno" del Director con la sección de OC: **35be0e4**.

### Edge Functions
Cada función está versionada en Supabase. Revertir desde
Supabase → Edge Functions → (función) → Deployments → re-deploy de una versión anterior.

### Inventario / OC en NetSuite
- Una OC pendiente se anula poniéndola en **Rechazado** (approvalStatus=3).
- Un ajuste de inventario se revierte con un ajuste opuesto (no se borra, se compensa).
- Un recibo (Item Receipt) se anula desde NetSuite (eliminar/void el recibo) y reabre el saldo de la OC.

### Función upload-director-to-github
A partir de 2026-06-23 quedó sincronizada con la versión actual de director.html
(la que incluye la sección de Órdenes de compra). Re-correrla vuelve a publicar la versión vigente.

---

*Archivo de respaldo generado el 2026-06-23. Acompaña a las copias de director.html y
control_cemento_silos.html en esta misma carpeta de OneDrive.*
