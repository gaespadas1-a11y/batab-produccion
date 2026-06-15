# Bitácora técnica — Tablero de Producción BATAB (EN VIVO)

**Fecha:** 15-jun-2026 · **Autor:** Gerardo Espadas (Dir. General / admin NetSuite) + Claude
**Estado:** En producción · v2.1 (tablero) · v2 (endpoint)
**Propósito:** Tablero de control de producción para supervisor y gerencia (qué producir), leyendo NetSuite en tiempo real.

---

## 1. Arquitectura

```
panel_produccion.html  (navegador / OneDrive / futura URL fija)
        │  fetch cada 5 min (+ respaldo automático si falla)
        ▼
Supabase edge function  panel-produccion  (proyecto szrcmvlgxxpmvgrfmxak)
        │  OAuth 1.0a TBA HMAC-SHA256 (misma firma que netsuite-proxy)
        ▼
NetSuite SuiteQL REST  (cuenta 7905968)  —  CR1417 + órdenes de venta + existencia
```

- **Endpoint en vivo:** `https://szrcmvlgxxpmvgrfmxak.supabase.co/functions/v1/panel-produccion`
- **verify_jwt:** false · **anon key (fetch):** `sb_publishable_VOhn9Z2Ev8gYK3nFKr44Sw_VngbAX4N`
- **Secrets NetSuite reutilizados (ya configurados):** NS_CONSUMER_KEY/SECRET, NS_TOKEN_ID/SECRET
- Devuelve JSON: `{ corte, ventana, kpis[], fases[], lineas[], legacy }`

## 2. Lógica de negocio (clave)

**Faltante neto a producir = Necesidad − Existencia (firme) − En proceso (tentativo)**

- **Existencia:** `item.totalQuantityOnHand` de NetSuite (sumado por SKU). Verificado: coincide EXACTO con NetSuite.
- **Necesidad:** suma de líneas de órdenes de venta abiertas (status B/D/E), ventana **anual móvil** `t.trandate >= ADD_MONTHS(TRUNC(SYSDATE),-12)` (se recorre sola cada día). NO es un campo nativo; es cálculo desde las OV reales.
- **En proceso:** suma de `custrecord_batab_prod_reportada` de lotes del pipeline SIN Build (status 5/9/11). Son piezas ya producidas (capturado/QC/curado) pero aún sin postear a inventario. **Tentativas** — sujetas a pasar QC; si se rechazan, el faltante sube al "bruto" (= Necesidad − Existencia).
- **Faltante (NO nativo):** equivalente conceptual al "Back Order / Cantidad en espera" de NetSuite (la API no lo expone).
- Faltante SIEMPRE por SKU (el excedente de un modelo no cubre el déficit de otro). Cantidades enteras.

## 3. Máquina de estados CR1417 (customrecord_batab_produccion)

| status | significado |
|--------|-------------|
| 5  | Capturado · aprobado supervisor F1 · pendiente QC |
| 9  | En QC (entre compuertas G1 y G2) |
| 11 | QC G2 superada · listo para cierre del director |
| 7  | Cerrado (Build creado y posteado en NetSuite) |
| APROBADO | grupo legacy (mar–abr, 37 WO cerradas SIN Build, operador nulo) — pendiente depurar |

Pipeline = `custrecord_batab_build_id IS NULL` y status en (5,9,11). Campos: `_lote, _articulo, _status, _linea, _turno, _prod_reportada (pz), _workorder, _operador, _build_id`. Lotes con operador "OPERADOR PRUEBA" = pruebas.

## 4. Consultas SuiteQL (validadas vía MCP)

**A. Conteos por estatus (KPIs):**
```sql
SELECT custrecord_batab_status status, COUNT(*) n,
  SUM(CASE WHEN custrecord_batab_build_id IS NULL THEN 1 ELSE 0 END) nobuild
FROM customrecord_batab_produccion WHERE isinactive='F'
GROUP BY custrecord_batab_status
```

**B. Lotes del pipeline (operativo + piezas en proceso):**
```sql
SELECT custrecord_batab_lote lote, custrecord_batab_articulo articulo,
  custrecord_batab_status status, custrecord_batab_linea linea,
  custrecord_batab_turno turno, custrecord_batab_prod_reportada pz,
  custrecord_batab_workorder wo, custrecord_batab_operador operador
FROM customrecord_batab_produccion
WHERE isinactive='F' AND custrecord_batab_build_id IS NULL
  AND custrecord_batab_status IN ('5','9','11')
ORDER BY custrecord_batab_status, custrecord_batab_fecha
```

**C. Existencia + necesidad por SKU (ventana anual móvil):**
```sql
SELECT i.itemid item, i.displayname gama,
  NVL((SELECT SUM(ib.quantityonhand) FROM inventorybalance ib WHERE ib.item=i.id),0) existencia,
  NVL((SELECT ABS(SUM(tl.quantity - NVL(tl.quantityshiprecv,0)))
       FROM transaction t INNER JOIN transactionline tl ON tl.transaction=t.id
       WHERE tl.item=i.id AND t.type='SalesOrd' AND t.status IN ('B','D','E')
         AND t.trandate >= ADD_MONTHS(TRUNC(SYSDATE),-12)
         AND tl.mainline='F' AND tl.taxline='F'),0) necesidad
FROM item i WHERE i.itemid LIKE 'BLOCK %-%'
ORDER BY i.displayname, i.itemid
```
- Las cantidades de OV vienen NEGATIVAS (líneas de venta) → `ABS()`.
- Gama = `displayname` sin "BLOCK ". SKU = `itemid` después de "BLOCK <gama> - ". Líneas comerciales: EMBLEMA, AVANCE, FORTALEZA, VITTA, PRISMA.
- "En proceso" por SKU = suma de `pz` de la consulta B agrupada por `articulo`.

## 5. Tablero (panel_produccion.html v2.1)

- Diseño industrial: grafito #14171C, ocre #E8A33D, fuentes Space Grotesk / IBM Plex Mono / Inter.
- Hace `fetch` al endpoint; indicador "en vivo" (verde) / "respaldo" (ámbar); auto-refresco 5 min; FALLBACK embebido por si el endpoint falla.
- Dos vistas: (1) Pipeline operativo por fase (supervisor); (2) Decisión gerencial: por gama con tres capas — Existencia / En proceso / Necesidad — y faltante neto. Columnas por artículo: Nec · Exist · Proc · Falta neto · Cobertura (barra de 2 segmentos: sólido = firme, rayado = en proceso/tentativo).

## 6. Pendientes / decisiones abiertas

1. **Correo a gerencia:** función `panel-produccion-email` por crear (reutilizar MS Graph app-only de sharepoint-upload). Destinatarios: Mario Cuevas (Gte. Producción, emp 3819, Manager4Batab@outlook.com) e Ing. Elías Hernández (Gte. General, emp 3813, Manager1Batab@outlook.com). **Falta confirmar:** ¿@outlook.com o @batab.mx? y cadencia (propuesto: digest diario 7:00 AM + botón manual).
2. **Lotes de prueba:** "En proceso" actualmente suma lotes PRUEBA del pipeline. Decidir si excluirlos del neteo (filtro por operador) hasta que entre producción real.
3. **Hospedaje URL fija** para compartir con supervisor, Mario y Elías (GitHub Pages: github-upload / upload-director-to-github; o Supabase Storage).
4. **Legacy:** 37 WO "APROBADO" cerradas sin Build — confirmar si se posteó por otra ruta o depurar huérfanos.

## 7. Cómo hacer cambios futuros

- **Endpoint/datos:** editar `panel-produccion/index.ts` en Supabase (proyecto szrcmvlgxxpmvgrfmxak) y redeploy. La firma OAuth está copiada verbatim de `netsuite-proxy` (no tocar).
- **Tablero/UI:** editar `panel_produccion.html` (todo en un archivo: CSS + JS inline).
- **Verificación:** `existencia` debe cuadrar con `item.totalQuantityOnHand`; `necesidad` con OV abiertas; correr SuiteQL vía MCP NetSuite antes de cambiar la lógica.
- Regla: un solo camino por lote; cantidades enteras; descuento de humedad solo a agregados; consultar esta bitácora antes de proponer fixes.

---

## 8. ACTUALIZACIÓN 15-jun — Hospedaje y QR (RESUELTO)

**URL pública oficial del tablero (GitHub Pages, renderiza HTML):**
`https://gaespadas1-a11y.github.io/batab-produccion/tablero.html`
- Repo: `gaespadas1-a11y/batab-produccion` (mismo de `director.html`), rama `main`, archivo `tablero.html`.
- Es la URL para el **QR** y para **compartir** con supervisor, Mario y Elías.

**Hallazgo importante (no perder tiempo en el futuro):** Supabase **sirve archivos HTML como texto plano a propósito** (anti-phishing), tanto en edge functions como en Storage — la doc lo dice: *"For security, HTML files are returned as plain text."* Por eso un tablero HTML NO se puede servir desde `*.supabase.co`. **Hospedar siempre en GitHub Pages** (o batab.mx). Supabase queda solo para los datos (endpoint `panel-produccion`).

**Para actualizar el tablero a futuro:** subir el nuevo `tablero.html` al repo `gaespadas1-a11y/batab-produccion` (vía GitHub API / función `upload-director-to-github` como patrón). La misma URL del QR servirá la nueva versión.

**Funciones nuevas desplegadas hoy:**
- `tablero` (obsoleta — intento de servir desde Supabase; reemplazada por GitHub Pages)
- `publicar-tablero` (obsoleta — intento vía Storage)
- `guardar-qr` (genera y guarda el QR en OneDrive)
- `guardar-bitacora` (guarda bitácora + tablero + QR en OneDrive; ahora jala de GitHub)

Pendiente #3 (hospedaje) → **RESUELTO** con GitHub Pages.
