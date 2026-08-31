/**
 * BATAB — RESTlet de Autorizacion de Notas de Credito
 * ===================================================
 * @NApiVersion 2.1
 * @NScriptType Restlet
 *
 * ---------------------------------------------------------------------------
 * POR QUE EXISTE ESTE SCRIPT
 * ---------------------------------------------------------------------------
 * La cuenta tiene un workflow que BLOQUEA la nota de credito mientras esta
 * pendiente de autorizacion (custbody_requiere_autorizacion = T y
 * custbody_nc_autorizado = F). Ese candado aplica a TODO acceso externo:
 *
 *     GET/PATCH /services/rest/record/v1/creditMemo/{id}
 *     -> 400 "Este registro ha sido bloqueado por un flujo de trabajo
 *             definido por el usuario."  (USER_ERROR)
 *
 * Se comprobo el 24-ago-2026 con CM3958 (id 218366): ni siquiera se puede LEER
 * el registro por REST, con rol de administrador. El candado es a nivel
 * registro, no de permisos.
 *
 * El candado deja fuera a la API pero NO a SuiteScript en servidor. Por eso la
 * app del Director escribe el sello a traves de este RESTlet en vez de por el
 * REST Record API.
 *
 * Se dejo como script APARTE del "BATAB - Ensambles RESTlet" (script 2726) a
 * proposito: aquel maneja Fase 2 de produccion y no se toca por un cambio de
 * facturacion.
 *
 * ---------------------------------------------------------------------------
 * DESPLIEGUE
 * ---------------------------------------------------------------------------
 *   ID de script      : customscript_bat_nc_autorizar
 *   ID de despliegue  : customdeploy_bat_nc_autorizar
 *   Ejecutar como     : Administrador
 *   Estado            : Publicado / Liberado
 *   Roles             : incluir "BAT: Rol integrador Netsuite"
 *
 * Los IDs importan: la edge function arma la URL con esas cadenas, no con los
 * ids internos numericos. Si NetSuite les pone otro nombre, hay que ajustar
 * las variables de entorno NS_RL_NC_SCRIPT / NS_RL_NC_DEPLOY en Supabase.
 *
 * ---------------------------------------------------------------------------
 * CONTRATO
 * ---------------------------------------------------------------------------
 * POST { action: "autorizar" | "rechazar" | "ping",
 *        ncId: 218366,
 *        motivo: "texto (solo en rechazar)",
 *        dry_run: false }
 *
 * Respuesta:
 * { success, action, ncId, tranid, antes:{...}, escrito:{...},
 *   metodo:"submitFields"|"load+save", idempotente, mensaje }
 *
 * ---------------------------------------------------------------------------
 * CAMBIOS
 * ---------------------------------------------------------------------------
 * v1.0.0 (24-ago-2026)
 *   - Primera version. Nace para destrabar CM3958.
 *
 * v1.1.0 (31-ago-2026)
 *   - AUTORIZAR ya no limpia custbody_requiere_autorizacion. Ver comentario en
 *     el bloque de valores. Cambio propuesto por Jerson tras comprobar en
 *     CM3960 que el sello se escribia bien pero el candado no se liberaba.
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

  var ITEM_DESCUENTO = 1555;              // DESCUENTO/BONIFICACION S/VENTAS
  var F_AUTORIZADO   = 'custbody_nc_autorizado';
  var F_REQUIERE     = 'custbody_requiere_autorizacion';
  var F_UUID         = 'custbody_mx_cfdi_uuid';
  var F_OBS          = 'custbodycustbody_bat_observaciones';
  var VER            = 'v1.1.0';

  /** Lee el estado actual sin cargar el registro (lookupFields no choca con el candado). */
  function leerEstado(ncId) {
    var f = search.lookupFields({
      type: search.Type.CREDIT_MEMO,
      id: ncId,
      columns: ['tranid', 'entity', 'total', F_AUTORIZADO, F_REQUIERE, F_UUID]
    });
    return {
      tranid: f.tranid || '',
      cliente: (f.entity && f.entity.length) ? f.entity[0].text : '',
      total: Math.abs(parseFloat(f.total || 0)),
      autorizado: f[F_AUTORIZADO] === true,
      marcada: f[F_REQUIERE] === true,
      uuid: f[F_UUID] || null
    };
  }

  /** Suma del articulo de descuento en las lineas. Define si la NC entra al carril. */
  function montoDescuento(ncId) {
    var total = 0;
    search.create({
      type: search.Type.TRANSACTION,
      filters: [
        ['internalid', 'anyof', ncId], 'AND',
        ['mainline', 'is', 'F'], 'AND',
        ['item', 'anyof', ITEM_DESCUENTO]
      ],
      columns: ['amount']
    }).run().each(function (r) {
      total += Math.abs(parseFloat(r.getValue('amount') || 0));
      return true;
    });
    return total;
  }

  /**
   * Escribe los campos. submitFields es la via barata y la que mejor libra el
   * candado del workflow; si truena se intenta load+save, que tambien corre en
   * servidor. Se devuelve cual de las dos funciono para poder diagnosticar.
   */
  function escribir(ncId, valores) {
    try {
      record.submitFields({
        type: record.Type.CREDIT_MEMO,
        id: ncId,
        values: valores,
        options: { enableSourcing: false, ignoreMandatoryFields: true }
      });
      return { metodo: 'submitFields', ok: true, error: null };
    } catch (e1) {
      log.audit({ title: 'submitFields fallo, intento load+save', details: ncId + ' :: ' + e1.message });
      try {
        var rec = record.load({ type: record.Type.CREDIT_MEMO, id: ncId, isDynamic: false });
        for (var k in valores) {
          if (Object.prototype.hasOwnProperty.call(valores, k)) {
            rec.setValue({ fieldId: k, value: valores[k] });
          }
        }
        rec.save({ enableSourcing: false, ignoreMandatoryFields: true });
        return { metodo: 'load+save', ok: true, error: null };
      } catch (e2) {
        return {
          metodo: 'ninguno',
          ok: false,
          error: 'submitFields: ' + e1.message + ' || load+save: ' + e2.message
        };
      }
    }
  }

  function post(body) {
    var action = String((body && body.action) || 'autorizar').toLowerCase();
    if (action === 'ping') {
      return { success: true, version: VER, mensaje: 'RESTlet de notas de credito vivo' };
    }

    var ncId = parseInt(body && body.ncId, 10);
    if (!ncId) return { success: false, version: VER, error: 'ncId requerido (numerico)' };

    var dryRun = !!(body && body.dry_run);
    var motivo = String((body && body.motivo) || '').trim();

    var antes;
    try {
      antes = leerEstado(ncId);
    } catch (e) {
      return { success: false, version: VER, ncId: ncId, error: 'No se pudo leer la NC: ' + e.message };
    }

    var descuento = 0;
    try { descuento = montoDescuento(ncId); } catch (e) { /* si falla, manda la marca */ }
    antes.descuento = descuento;

    // Carril: articulo de descuento o marca explicita del capturista.
    if (descuento <= 0 && !antes.marcada) {
      return {
        success: false, version: VER, ncId: ncId, tranid: antes.tranid,
        error: 'NC fuera del carril de autorizacion',
        detalle: 'No trae el articulo ' + ITEM_DESCUENTO + ' ni viene marcada "Requiere autorizacion".',
        antes: antes
      };
    }

    // Idempotencia: el sello ya puesto no se reescribe.
    if (action === 'autorizar' && antes.autorizado) {
      return {
        success: true, version: VER, ncId: ncId, tranid: antes.tranid,
        idempotente: true, antes: antes,
        mensaje: 'NC ' + antes.tranid + ' ya estaba autorizada. No se reintenta.'
      };
    }

    // v1.1.0: al AUTORIZAR se escribe UNICAMENTE el sello.
    // La marca "Requiere autorizacion" se deja intacta a proposito: el workflow
    // BATAB | Aprobar nota de credito arranca con la condicion
    //   Requiere autorizacion = T Y Autorizado = F
    // y si se limpian los dos campos en el mismo submitFields, la instancia
    // deja de cumplir el alcance del flujo y la transicion condicionada a
    // Autorizado = T no llega a evaluarse. Dejando la marca puesta, el flujo
    // conserva el contexto y solo cambia la condicion que dispara la salida.
    // La NC igual sale del carril del Director: ese listado filtra por
    // custbody_nc_autorizado = 'F', no por la marca.
    var valores = {};
    if (action === 'rechazar') {
      valores[F_AUTORIZADO] = false;
      valores[F_REQUIERE] = false;
    } else {
      valores[F_AUTORIZADO] = true;
    }

    if (dryRun) {
      return {
        success: true, version: VER, ncId: ncId, tranid: antes.tranid,
        action: action, dry_run: true, antes: antes, escribiria: valores
      };
    }

    var res = escribir(ncId, valores);

    // La observacion del rechazo va aparte: si el id de campo no existe, el
    // rechazo no debe perderse por eso.
    var obs = null;
    if (action === 'rechazar' && motivo && res.ok) {
      var v = {};
      v[F_OBS] = ('RECHAZADA POR DIRECCION: ' + motivo).substring(0, 3000);
      var r2 = escribir(ncId, v);
      obs = { ok: r2.ok, error: r2.error };
    }

    var despues = null;
    try { despues = leerEstado(ncId); } catch (e) { /* no critico */ }

    log.audit({
      title: 'NC ' + action,
      details: antes.tranid + ' | id ' + ncId + ' | ' + (res.ok ? 'OK por ' + res.metodo : 'FALLO :: ' + res.error)
    });

    return {
      success: res.ok,
      version: VER,
      ncId: ncId,
      tranid: antes.tranid,
      action: action,
      metodo: res.metodo,
      error: res.error,
      antes: antes,
      despues: despues,
      observacion: obs,
      advertencia: antes.uuid ? 'La NC ya tenia UUID: el sello es posterior al timbrado.' : null
    };
  }

  function get() {
    return JSON.stringify({ success: true, version: VER, mensaje: 'bat_nc_autorizar vivo' });
  }

  return { get: get, post: post };
});
