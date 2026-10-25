/*! KINDO v4-patch.js - compatibilidad del front con el backend v4.0.0-gas
 *
 * Se carga DESPUÉS del script principal, con esta línea justo antes de </body>:
 *   <script src="v4-patch.js"></script>
 *
 * Qué hace:
 *  - Token de sesión en cada llamada y aviso de sesión vencida
 *  - Errores de red y de servidor visibles (se recarga el stock)
 *  - Estado REORDENAR de la planilla tratado como REORDEN
 *  - Costos y margen solo para ADMIN
 *  - Lead time real (sin hora inventada) y SLA por canal
 * Cuando esto se integre en index.html, este archivo se puede borrar.
 */
(function () {
  "use strict";

  // Deployment vigente de Apps Script (reemplaza a GAS_URL de index.html)
  var GAS_URL_V4 =
    "https://script.google.com/macros/s/AKfycbxR1uJamK6CiJewk9Y3ibPp2aMuFciABiNb-Nhi4onFIfE7bUtss9PVFedAgq-WTNnj/exec";
  var TOKEN_KEY = "kindo_session_token";

  // Meta de preparación en minutos por canal. CONFIRMAR los valores con el profesor.
  var SLA_TARGET_MIN = {
    "Uber Flash (Cba Capital)": 45,
    "Andreani (Federal)": 480,
    "Retiro Dark Store": 45,
  };

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }
  function isAdmin() {
    return !!currentUser && currentUser.rol === "ADMIN";
  }

  function handleActionError(res) {
    closeLabelModal();
    alert(
      "No se pudo registrar la operación: " +
        ((res && res.message) || "sin respuesta del servidor") +
        "\nSe recargó el stock.",
    );
    fetchStock();
  }

  // Conector JSONP con token, sesión vencida y errores de red
  window.callAPI = function (action, params, callback) {
    params = params || {};
    var cbName =
      "kindo_cb_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
    var script = document.createElement("script");
    var started = performance.now();

    params.ip = clientIP;
    params.ua = navigator.userAgent;
    if (action !== "login" && getToken()) params.token = getToken();

    function done(data) {
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
      if (data && data.version) {
        document.getElementById("ver-backend").innerText = data.version;
      }
      if (action === "login" && data && data.status === "success" && data.token) {
        localStorage.setItem(TOKEN_KEY, data.token);
      }
      if (
        action !== "login" &&
        data &&
        data.status === "unauthorized" &&
        data.message === "SESION_INVALIDA"
      ) {
        window.forceLogout();
        document.getElementById("login-error").innerText =
          "Tu sesión venció. Ingresá de nuevo.";
        return;
      }
      if (
        action !== "login" &&
        action !== "getStock" &&
        (!data || data.status !== "success")
      ) {
        handleActionError(data);
      }
      callback(data);
    }

    window[cbName] = function (data) {
      devLog(
        "API",
        "Respuesta para [" + action + "] (" + Math.round(performance.now() - started) + "ms):",
        data,
      );
      done(data);
    };

    var qs = GAS_URL_V4 + "?action=" + action + "&callback=" + cbName;
    for (var k in params) {
      qs += "&" + k + "=" + encodeURIComponent(params[k]);
    }
    script.src = qs;
    script.onerror = function () {
      devLog("API", "Error de red en [" + action + "]");
      document.getElementById("kpi-sync").innerText = "🔴";
      done({ status: "network_error", message: "Sin conexión con el servidor." });
    };
    document.body.appendChild(script);
  };

  // Salir: también borra el token
  var origForceLogout = window.forceLogout;
  window.forceLogout = function () {
    localStorage.removeItem(TOKEN_KEY);
    return origForceLogout.apply(this, arguments);
  };

  // Al abrir: sesiones sin token (de la versión vieja) se cierran; sin hora de orden inventada
  var origVerify = window.verifySession;
  window.verifySession = function () {
    if (localStorage.getItem("kindo_session_data") && !getToken()) {
      localStorage.removeItem("kindo_session_data");
      localStorage.removeItem("kindo_session_stamp");
    }
    var r = origVerify.apply(this, arguments);
    document.getElementById("ver-client").innerText = HTML_VERSION + " + v4-patch";
    document.getElementById("order-id").value = "";
    document.getElementById("order-time").value = "";
    return r;
  };
  window.onload = window.verifySession; // index.html capturó la función original

  // La planilla devuelve REORDENAR; la app espera REORDEN
  var origKPIs = window.updateKPIs;
  window.updateKPIs = function () {
    catalog.forEach(function (i) {
      if (i.estado === "REORDENAR") i.estado = "REORDEN";
    });
    return origKPIs.apply(this, arguments);
  };

  // Lead time real, SLA por canal y costos solo para ADMIN
  var origCalc = window.calculateLogisticsCost;
  window.calculateLogisticsCost = function () {
    var r = origCalc.apply(this, arguments);
    var leadEl = document.getElementById("c-lead-time");
    var hasTime = !!document.getElementById("order-time").value;
    var mins = parseInt(r.leadTime, 10);

    if (!hasTime) {
      r.leadTime = "N/A";
      r.slaStatus = "SIN HORA DE ORDEN";
      if (leadEl)
        leadEl.innerHTML =
          'N/A <span class="sla-pill sla-warn">SIN HORA DE ORDEN</span>';
    } else if (!isNaN(mins)) {
      var canal = document.getElementById("dispatch-canal").value;
      var ok = mins <= (SLA_TARGET_MIN[canal] || 45);
      r.slaStatus = ok ? "SLA CUMPLIDO" : "RIESGO SLA";
      if (leadEl)
        leadEl.innerHTML =
          mins + ' min <span class="sla-pill ' + (ok ? "sla-ok" : "sla-warn") + '">' + r.slaStatus + "</span>";
    }

    var card = document.getElementById("cost-breakdown-card");
    if (card && !isAdmin()) card.style.display = "none";
    return r;
  };

  // Despacho: N° de orden "S/D" si está vacío, margen oculto al operador, limpiar campos
  var origSubmit = window.submitDispatch;
  window.submitDispatch = function () {
    var oid = document.getElementById("order-id");
    if (!oid.value.trim()) oid.value = "S/D";
    var r = origSubmit.apply(this, arguments);
    if (!isAdmin()) {
      var fb = document.getElementById("dispatch-feedback");
      if (fb) fb.innerHTML = fb.innerHTML.replace(/ \| MgNeto: [^<]*/, "");
    }
    document.getElementById("order-id").value = "";
    document.getElementById("order-time").value = "";
    return r;
  };
})();
