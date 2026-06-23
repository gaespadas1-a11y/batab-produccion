Soy Gerardo Espadas Hernández, Director General y administrador de NetSuite de BATAB
(Bloques y Agregados de Tabasco, fabricante de blocks en Teapa, Tabasco). Continúo un
proyecto: ayer construimos un sistema completo de control de cemento y hoy quiero empezar
la app de AGREGADOS, comenzando por el módulo de INVENTARIO. Trabajo en español, estilo
directo, y prefiero que ejecutes de forma autónoma con respaldo antes de cada cambio
importante. Conectores activos: NetSuite, Supabase, Microsoft 365, Netlify, Google Drive.

═══════════════════════════════════════════════════════════════════
LO QUE YA ESTÁ CONSTRUIDO Y FUNCIONANDO (sistema de cemento — NO tocar, está en producción)
═══════════════════════════════════════════════════════════════════

ARQUITECTURA: Frontends en GitHub Pages → Edge Functions en Supabase → NetSuite (libro)
+ Supabase (físico) + MS Graph (correo). Principio: Existencia NetSuite − Consumo en
tránsito (lotes sin Build) = Disponible real = Físico en silos.

APPS (repo GitHub gaespadas1-a11y/batab-produccion, rama main):
- App de Cemento: https://gaespadas1-a11y.github.io/batab-produccion/cemento/
- App BATAB Director: https://gaespadas1-a11y.github.io/batab-produccion/director.html
  (El despliegue se hace por push directo a GitHub vía la API. El token de GitHub está como
   fallback dentro de la edge function upload-director-to-github.)

EDGE FUNCTIONS (Supabase, proyecto szrcmvlgxxpmvgrfmxak, todas verify_jwt=false):
- cemento-api: GET=estado vivo (silos+existencia+tránsito+disponible+PO); POST action=entrada
  (guarda en Supabase, sube silo, crea recibo de PO). Idempotente por folio, no sobre-recibe.
- solicitar-cemento v3: crea OC de cemento (CEMEX/HOLCIM, 30/50 t) pendiente. Con seguro
  anti-duplicados (no crea otra si ya hay una del mismo item pendiente de aprobación).
- aprobar-oc v2: aprueba (status 2) o rechaza (status 3) una OC. Al aprobar, si es de cemento
  manda correo a los 4 gerentes vía MS Graph desde ceo3@batab.mx. Params: accion, dry_run, solo_prueba.
- recibir-oc: transform PO→ItemReceipt por cantidad exacta. La usa cemento-api.
- sharepoint-upload: sube/lista/descarga en OneDrive vía MS Graph (endpoints /upload, /list, /download).
- netsuite-proxy: proxy SuiteQL/REST a NetSuite (lo usan cemento-api y el Director).
- upload-director-to-github v9: re-publica la versión vigente de director.html (idempotente, ya no revierte).

TABLAS SUPABASE (cemento): silos, entregas_cemento, entregas_cemento_unidades,
cemento_movimientos, cemento_transito.

DIRECTOR — sección de aprobaciones: dos segmentos. "Aprobación de materias primas"
(toda OC con items cuyo item.fullname empieza con 'MATERIAS PRIMA' → cemento, agregados,
aditivos) y "Otras órdenes de compra" (refacciones, fletes, etc.). Cada OC tiene botones
APROBAR · Rechazar · Ver OC. IMPORTANTE: las OC de agregados YA caen solas en el segmento
de materias primas (no hay que hacer nada extra para que aparezcan al aprobarlas).

DATOS CLAVE NETSUITE (cuenta 7905968, subsidiaria 2):
- Cemento: item 1230 (CPC-40-RS, vendor CEMEX 126), item 1232 (CPC-40, vendor HOLCIM 7934).
- Agregados (ya existen como items): polvo = 1347 ("MATERIAS PRIMAS - AGREGADOS - POLVO 3/16 AFI"),
  sello = 1350 ("MATERIAS PRIMAS - AGREGADOS - SELLO3/8"). Verificar en NetSuite si existen
  items de arena fina / arena gruesa, o si hay que crearlos.
- Proveedor de agregados: CATAB = COMERCIALIZADORA DE AGREGADOS TABASQUEÑOS (vendor 127).
- Almacén Materia Prima = location 22. Unidad de compra cemento = TONELADA (id 24); base = KG.
- Cuenta ajuste recuento físico = 1360 (COGS), customForm 257.
- CR producción = customrecord_batab_produccion (CR 1417); status 7 = cerrado; el Build asienta consumo.

CONTROL DE CALIDAD existente: tablas Supabase ensayes_qc y probetas_qc; en NetSuite CR 933
(cabecera ensaye) y CR 934 (probetas). Gates: G1 ≥ 40 kg/cm² (promedio de 3), G2 ≥ 50 cada una;
FORTALEZA G1=50 G2=90.

GRANULOMETRÍA (análisis ya hecho, base del módulo): el polvo de piedra de CATAB es gap-graded
(déficit en mallas 30–50), F.M. ~3.2 vs objetivo 3.70. La arena gruesa (rica en mallas 16–30–50)
es el material crítico faltante. Receta recomendada: Arena fina 59% + Arena gruesa 32% + Sello 9%
→ F.M. 3.71. Besser y Columbia apuntan a F.M. 3.70 (rango 3.60–3.80).

MS GRAPH (app BATAB Claude): tenant ab7e797d-044d-4aa6-b259-05666d10a947,
client 15cebb63-75d1-46a5-a505-7fb48f69c345 (Mail.Send + Files.ReadWrite.All).
Correo notificación desde ceo3@batab.mx a: Juan Paredes (manager2batab@outlook.com),
Elías Hernández (Manager1Batab@outlook.com), Mario Cuevas (Manager4Batab@outlook.com),
Dina Villalobos (Payroll1Batab@outlook.com).

RESPALDOS: TODO está respaldado en la BIBLIOTECA TÉCNICA de OneDrive, carpeta
07_Biblioteca_Tecnica/Sistema_Cemento_2026-06-23 — incluye director.html,
control_cemento_silos.html, el documento maestro _ARQUITECTURA_Y_ROLLBACK.md (arquitectura
completa, IDs, esquema de tablas y pasos de reversión de cada pieza) y este prompt.
(También hay copia en 10_App_Supervisor/Control_Cemento/_Respaldo_2026-06-23.)

═══════════════════════════════════════════════════════════════════
LO QUE QUIERO HOY: empezar la APP DE AGREGADOS
═══════════════════════════════════════════════════════════════════

Calcada del patrón del cemento (GitHub Pages → Supabase → NetSuite). Plan por módulos:
1. INVENTARIO (HOY) — materiales (polvo, sello, arena fina, arena gruesa) por patio/tolva,
   con niveles, mínimos y conciliación contra NetSuite, como fueron los silos del cemento.
2. Granulometría — capturar el cribado por mallas → calcular F.M. → comparar vs 3.70 → sugerir mezcla.
3. Control de calidad de agregados.
Y "colgado" del inventario: Solicitar/Recibir OC de agregados (a CATAB), que ya engancha
con el segmento de materias primas del Director.

DECISIÓN PENDIENTE (pregúntamela al inicio): ¿la app de Agregados es independiente, o son
secciones dentro de una sola app de "Materias Primas" que junte cemento + agregados?

Empecemos por el módulo de INVENTARIO de agregados. Antes de codificar, primero revisa en
NetSuite los items de agregados reales (polvo, sello, arenas), sus existencias y unidades,
y proponme el modelo de datos (patios/tolvas) y el plan, como hicimos con los silos.
