/**
 * bat_nc_bloqueo_timbrado.js  -  BATAB  -  v1.0  -  06-ago-2026
 *
 * PROPOSITO
 * Impedir que se timbre (genere CFDI) una Nota de Credito de cliente que no haya sido
 * autorizada por Direccion General desde la App del Director.
 *
 * CONTEXTO
 * NetSuite NO tiene flujo de aprobacion nativo para Credit Memo (approvalstatus siempre
 * queda nulo en CustCred). El control de BATAB se lleva con dos campos personalizados
 * que ya existen en el registro:
 *     custbody_requiere_autorizacion  -> "Requiere autorizacion"  (marca del capturista)
 *     custbody_nc_autorizado          -> "Autorizado"             (sello de Direccion)
 * La App del Director (director.html v3.9.0) muestra las NC pendientes y marca
 * custbody_nc_autorizado = T via la edge function `aprobar-nota-credito` v1.0.
 *
 * QUE HACE
 * En beforeSubmit detecta el momento en que la NC pasa de "sin CFDI" a "con CFDI"
 * (aparece UUID, firma del SAT o el estado del documento electronico se mueve).
 * Si en ese instante la NC entra al carril de autorizacion y NO esta autorizada,
 * lanza un error y el timbrado no procede.
 *
 * CARRIL DE AUTORIZACION (politica DG 06-ago-2026)
 *   - NC que traiga el articulo de descuento 1555 (DESCUENTO/BONIFICACION S/VENTAS), o
 *   - NC marcada por el capturista con "Requiere autorizacion".
 * Las demas NC (amortizaciones de anticipo, ajustes de centavos, devoluciones) pasan
 * sin friccion.
 *
 * DESPLIEGUE
 *   Tipo:        User Event Script
 *   Aplicado a:  Nota de credito (Credit Memo)
 *   Ejecutar como: Administrador
 *   Contexto:    TODOS (dejar "Ejecutar como" y contextos por defecto). Es importante
 *                NO limitarlo a User Interface: el timbrado corre desde el bundle.
 *   Log level:   Auditoria
 *
 * ADVERTENCIA CONOCIDA
 * Si el bundle del PAC escribiera el UUID con record.submitFields({ignoreUserEvents:true}),
 * este bloqueo no se dispara. Probar con una NC real antes de darlo por bueno: capturar
 * una NC con el articulo 1555 e intentar timbrarla sin autorizar; debe salir el error.
 * Si el bundle la brinca, avisar para pasar al plan B (restringir el rol que timbra).
 */

define(['N/search', 'N/runtime'], function (search, runtime) {

  var ITEM_DESCUENTO = 1555;

  var CAMPOS_CFDI = [
    'custbody_mx_cfdi_uuid',
    'custbody_mx_cfdi_sat_signature',
    'custbody_mx_cfdi_certify_timestamp'
  ];

  function lleno(v) {
    return v !== null && v !== undefined && String(v).trim() !== '';
  }

  /** Detecta la transicion "sin CFDI" -> "con CFDI" comparando old vs new. */
  function seEstaTimbrando(oldRec, newRec) {
    for (var i = 0; i < CAMPOS_CFDI.length; i++) {
      var campo = CAMPOS_CFDI[i];
      var antes = oldRec ? oldRec.getValue({ fieldId: campo }) : null;
      var ahora = newRec.getValue({ fieldId: campo });
      if (!lleno(antes) && lleno(ahora)) return campo;
    }
    return null;
  }

  /** True si la NC trae al menos una linea con el articulo de descuento. */
  function traeDescuento(newRec) {
    try {
      var n = newRec.getLineCount({ sublistId: 'item' });
      for (var i = 0; i < n; i++) {
        var item = newRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
        if (parseInt(item, 10) === ITEM_DESCUENTO) return true;
      }
    } catch (e) {
      log.error({ title: 'traeDescuento', details: e });
    }
    return false;
  }

  function beforeSubmit(ctx) {
    // Solo interesa la edicion de un registro existente: el timbrado siempre es un update.
    if (ctx.type !== ctx.UserEventType.EDIT && ctx.type !== ctx.UserEventType.XEDIT) return;

    var nuevo = ctx.newRecord;
    var viejo = ctx.oldRecord;

    var campoDisparo = seEstaTimbrando(viejo, nuevo);
    if (!campoDisparo) return;  // no es un timbrado, seguir normal

    var autorizado = nuevo.getValue({ fieldId: 'custbody_nc_autorizado' }) === true;
    if (autorizado) {
      log.audit({
        title: 'NC timbrada con autorizacion',
        details: 'Doc ' + nuevo.getValue({ fieldId: 'tranid' }) + ' | campo ' + campoDisparo
      });
      return;
    }

    var marcada = nuevo.getValue({ fieldId: 'custbody_requiere_autorizacion' }) === true;
    var descuento = traeDescuento(nuevo);

    if (!marcada && !descuento) return;  // fuera del carril: se timbra sin friccion

    var tranid = nuevo.getValue({ fieldId: 'tranid' }) || '(sin folio)';
    var motivo = descuento
      ? 'contiene el articulo de descuento/bonificacion'
      : 'fue marcada como "Requiere autorizacion"';

    log.error({
      title: 'Timbrado bloqueado por falta de autorizacion',
      details: 'NC ' + tranid + ' | motivo: ' + motivo +
               ' | usuario: ' + runtime.getCurrentUser().name
    });

    throw new Error(
      'TIMBRADO BLOQUEADO. La nota de credito ' + tranid + ' ' + motivo +
      ', por lo que requiere autorizacion de Direccion General antes de emitir el CFDI. ' +
      'Direccion la autoriza desde la App del Director; al quedar autorizada aparece ' +
      'palomeado el campo "Autorizado" y este documento se puede timbrar.'
    );
  }

  return { beforeSubmit: beforeSubmit };
});
