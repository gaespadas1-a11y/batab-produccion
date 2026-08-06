// aprobar-nota-credito v1.0 - BATAB - 06-ago-2026
// Autoriza (custbody_nc_autorizado=T) o rechaza notas de credito de cliente (CustCred).
//
// CONTEXTO: NetSuite NO tiene flujo de aprobacion nativo para notas de credito
// (approvalstatus siempre null en CustCred). El control se lleva con dos campos
// personalizados que ya existen en el registro:
//   custbody_requiere_autorizacion  -> "Requiere autorizacion" (marca del capturista)
//   custbody_nc_autorizado          -> "Autorizado" (sello de Direccion General)
//
// POLITICA (Direccion General, 06-ago-2026):
//   - Entran al carril: NC que traigan el articulo de descuento 1555
//     (DESCUENTO/BONIFICACION S/VENTAS) O que vengan marcadas "Requiere autorizacion".
//   - SIN TOPE de importe: la Direccion aprueba con criterio propio.
//   - Idempotente: si ya esta autorizada, no reintenta.
//   - Anuladas (voided) no se tocan.
//   - Se advierte si la NC YA fue timbrada (UUID presente): en ese caso el sello es
//     posterior al CFDI y no funciona como freno. El freno real vive en el User Event
//     de NetSuite que bloquea el timbrado sin autorizacion.

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const NS_BASE = "https://7905968.suitetalk.api.netsuite.com";
const REALM = "7905968";
const CK = Deno.env.get("NS_CONSUMER_KEY") || "", CS = Deno.env.get("NS_CONSUMER_SECRET") || "", TI = Deno.env.get("NS_TOKEN_ID") || "", TS = Deno.env.get("NS_TOKEN_SECRET") || "";
const NS_PROXY = (Deno.env.get("SUPABASE_URL") || "") + "/functions/v1/netsuite-proxy";
const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const VER = "v1.0";
const ITEM_DESCUENTO = 1555;

async function trace(row: Record<string, unknown>): Promise<void> {
  try {
    if (!SB_URL || !SB_KEY) return;
    await fetch(SB_URL + "/rest/v1/netsuite_trace_log", {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ ...row, edge_function: "aprobar-nota-credito", edge_function_version: VER })
    });
  } catch (_) { /* best-effort */ }
}

function deny(motivo: string, detalle: string, nc: Record<string, unknown> | null, ncId: string) {
  trace({ evento: "nc_rechazo_validacion", validacion: "ERROR", validacion_detalle: motivo + " :: " + detalle, ns_transaction_id: parseInt(ncId) || null, ns_transaction_type: "creditmemo", request_payload: { ncId }, response_payload: nc, http_status: 403, error_message: motivo });
  return new Response(JSON.stringify({ ok: false, error: motivo, detalle, ncId, politica: "aprobar-nota-credito " + VER + ": solo NC con articulo de descuento " + ITEM_DESCUENTO + " o marcadas 'Requiere autorizacion'." }), { status: 403, headers: { ...CORS, "Content-Type": "application/json" } });
}

function oe(s: string): string { return encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()); }

async function oAuthHeader(method: string, url: string): Promise<string> {
  let u = url; const extra: Record<string, string> = {}; const qi = url.indexOf("?");
  if (qi !== -1) { u = url.substring(0, qi); for (const pr of url.substring(qi + 1).split("&")) { const [k, v] = pr.split("="); if (k) extra[decodeURIComponent(k)] = decodeURIComponent(v || ""); } }
  const t = Math.floor(Date.now() / 1000).toString();
  const n = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((b) => b.toString(36)).join("").substring(0, 16);
  const p: Record<string, string> = { oauth_consumer_key: CK, oauth_nonce: n, oauth_signature_method: "HMAC-SHA256", oauth_timestamp: t, oauth_token: TI, oauth_version: "1.0", ...extra };
  const ps = Object.keys(p).sort().map((k) => oe(k) + "=" + oe(p[k])).join("&");
  const bs = [method.toUpperCase(), oe(u), oe(ps)].join("&");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(oe(CS) + "&" + oe(TS)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const raw = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bs));
  const hp: Record<string, string> = { oauth_consumer_key: p.oauth_consumer_key, oauth_nonce: p.oauth_nonce, oauth_signature: btoa(String.fromCharCode(...new Uint8Array(raw))), oauth_signature_method: p.oauth_signature_method, oauth_timestamp: p.oauth_timestamp, oauth_token: p.oauth_token, oauth_version: p.oauth_version };
  return 'OAuth realm="' + REALM + '", ' + Object.keys(hp).map((k) => oe(k) + '="' + oe(hp[k]) + '"').join(", ");
}

async function suiteql(q: string) {
  const r = await fetch(NS_PROXY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "POST", endpoint: "/services/rest/query/v1/suiteql?limit=10", payload: { q }, extraHeaders: { Prefer: "transient" } }) });
  const j = await r.json(); if (!j.success) throw new Error("SuiteQL: " + JSON.stringify(j).substring(0, 200)); return (j.data && j.data.items) || [];
}

async function patchNC(id: string, body: Record<string, unknown>) {
  const url = NS_BASE + `/services/rest/record/v1/creditMemo/${id}`;
  const auth = await oAuthHeader("PATCH", url);
  const r = await fetch(url, { method: "PATCH", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const tx = await r.text(); return { ok: r.ok, status: r.status, error: r.ok ? null : tx.substring(0, 400) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const ncId = String(b.ncId || b.creditMemoId || "").trim();
    if (!ncId || !/^\d+$/.test(ncId)) return new Response(JSON.stringify({ ok: false, error: "ncId requerido (numerico)" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    const accion = String(b.accion || "aprobar").toLowerCase();
    const motivo = String(b.motivo || "").trim();
    const dryRun = !!b.dry_run;

    const rows = await suiteql(`SELECT t.tranid, t.type AS tipo, t.voided, BUILTIN.DF(t.entity) AS cliente, ABS(t.foreigntotal) AS total, t.memo, t.custbody_mx_cfdi_uuid AS uuid, NVL(t.custbody_nc_autorizado,'F') AS autorizado, NVL(t.custbody_requiere_autorizacion,'F') AS marcada, (SELECT NVL(SUM(ABS(tl.foreignamount)),0) FROM transactionline tl WHERE tl.transaction=t.id AND tl.item=${ITEM_DESCUENTO}) AS desc_monto FROM transaction t WHERE t.id=${ncId}`);
    if (!rows.length) return new Response(JSON.stringify({ ok: false, error: "Nota de credito no encontrada" }), { status: 404, headers: { ...CORS, "Content-Type": "application/json" } });

    const nc = rows[0];
    const total = Number(nc.total || 0);
    const descMonto = Number(nc.desc_monto || 0);
    const autorizado = String(nc.autorizado || "F") === "T";
    const marcada = String(nc.marcada || "F") === "T";
    const timbrada = !!(nc.uuid && String(nc.uuid).trim());

    // ===================== VALIDACIONES =====================
    if (String(nc.tipo || "") !== "CustCred") return deny("No es una nota de credito de cliente", `tipo=${nc.tipo}`, nc, ncId);
    if (String(nc.voided || "F") === "T") return deny("Nota de credito anulada", `NC ${nc.tranid} esta anulada (voided=T). No se autoriza.`, nc, ncId);

    // Solo el carril definido: descuento o marca explicita.
    if (descMonto <= 0 && !marcada) return deny("NC fuera del carril de autorizacion", `NC ${nc.tranid} no trae el articulo de descuento ${ITEM_DESCUENTO} ni viene marcada 'Requiere autorizacion'.`, nc, ncId);

    if (accion === "aprobar" && autorizado) {
      return new Response(JSON.stringify({ ok: true, idempotente: true, version: VER, ncId, tranid: nc.tranid, autorizacion: { ok: true, skipped: true }, mensaje: `NC ${nc.tranid} ya estaba autorizada. No se reintenta.` }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    // ===================== FIN VALIDACIONES =====================

    const validaciones = { cliente: nc.cliente, total_con_iva: total, descuento: descMonto, marcada_por_capturista: marcada, timbrada, uuid: nc.uuid || null, tope_importe: "sin tope (politica DG 06-ago-2026)" };

    if (accion === "rechazar") {
      let rech: Record<string, unknown> = { ok: true, skipped: true };
      const body: Record<string, unknown> = { custbody_nc_autorizado: false, custbody_requiere_autorizacion: false };
      if (motivo) body["custbodycustbody_bat_observaciones"] = ("RECHAZADA POR DIRECCION: " + motivo).substring(0, 3000);
      if (!dryRun) rech = await patchNC(ncId, body);
      await trace({ evento: "nc_rechazada", validacion: rech.ok ? "OK" : "ERROR", validacion_detalle: `NC ${nc.tranid} | ${nc.cliente} | $${total.toLocaleString("es-MX")} | rechazada${motivo ? " :: " + motivo : ""}`, ns_transaction_id: parseInt(ncId), ns_transaction_type: "creditmemo", request_payload: { ncId, accion, motivo, dry_run: dryRun }, response_payload: rech });
      return new Response(JSON.stringify({ ok: true, version: VER, ncId, tranid: nc.tranid, accion: "rechazar", validaciones, rechazo: rech }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }

    let aut: Record<string, unknown> = { ok: true, skipped: true };
    if (!dryRun) aut = await patchNC(ncId, { custbody_nc_autorizado: true, custbody_requiere_autorizacion: false });

    await trace({ evento: "nc_autorizada", validacion: aut.ok ? "OK" : "ERROR", validacion_detalle: `NC ${nc.tranid} | ${nc.cliente} | $${total.toLocaleString("es-MX")} c/IVA | descuento $${descMonto.toLocaleString("es-MX")} | ${timbrada ? "YA TIMBRADA (sello posterior)" : "sin timbrar (freno efectivo)"}`, ns_transaction_id: parseInt(ncId), ns_transaction_type: "creditmemo", request_payload: { ncId, accion, dry_run: dryRun }, response_payload: aut });

    return new Response(JSON.stringify({ ok: true, version: VER, ncId, tranid: nc.tranid, accion: "aprobar", validaciones, dry_run: dryRun, autorizacion: aut, advertencia: timbrada ? "La NC ya tenia UUID: este sello es posterior al timbrado." : null }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
