/* Chronik · Sprachwahl */
(function () {
  var S = window.CHRONIK_SPRACHEN = window.CHRONIK_SPRACHEN || {};
  var wahl = "";
  try { wahl = window.localStorage.getItem("chronik.sprache") || ""; } catch (e) { /* ohne Speicher */ }
  if (!S[wahl]) {
    var nav = String((navigator.languages && navigator.languages[0]) || navigator.language || "de").slice(0, 2).toLowerCase();
    wahl = S[nav] ? nav : (S.de ? "de" : Object.keys(S)[0] || "de");
  }
  var basis = (S.de && S.de.texte) || {};
  var eigen = (S[wahl] && S[wahl].texte) || {};
  var T = {};
  Object.keys(basis).forEach(function (k) { T[k] = basis[k]; });
  Object.keys(eigen).forEach(function (k) { T[k] = eigen[k]; });
  /* Name und Bilder der Anwendung kommen aus chronik-config.js (appName, bilder). */
  var C = window.CHRONIK_CONFIG || {};
  var NAME = String(C.appName || "Chronik").trim() || "Chronik";
  var MEHR = String(C.appNamePlural || (NAME === "Chronik" ? "Chroniken" : NAME)).trim();
  if (NAME !== "Chronik" || MEHR !== "Chroniken") {
    Object.keys(T).forEach(function (k) { if (typeof T[k] === "string") T[k] = T[k].replace(/Chroniken/g, MEHR).replace(/Chronik/g, NAME); });
  }
  window.CHRONIK_NAME = NAME;
  var B = C.bilder || {};
  function kopfSetzen() {
    try {
      if (!document.title || /Chronik/.test(document.title)) document.title = NAME;
      var m = document.querySelector('meta[name="apple-mobile-web-app-title"]'); if (m) m.setAttribute("content", NAME);
      var i = document.querySelector('link[rel="icon"]'); if (i && B.icon192) i.setAttribute("href", B.icon192);
      var a = document.querySelector('link[rel="apple-touch-icon"]'); if (a && B.icon180) a.setAttribute("href", B.icon180);
    } catch (e) { /* egal */ }
  }
  kopfSetzen();
  [300, 1500, 4000].forEach(function (t) { window.setTimeout(kopfSetzen, t); });
  window.CHRONIK_SPRACHE = wahl;
  window.CHRONIK_LOCALE = (S[wahl] && S[wahl].locale) || "de-DE";
  window.CHRONIK_T = T;
  window.tx = function (k) { return T[k] != null ? T[k] : k; };
  try { document.documentElement.lang = wahl; } catch (e) { /* egal */ }
})();
