/* Chronik · Sprachwahl*/
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
  window.CHRONIK_SPRACHE = wahl;
  window.CHRONIK_LOCALE = (S[wahl] && S[wahl].locale) || "de-DE";
  window.CHRONIK_T = T;
  window.tx = function (k) { return T[k] != null ? T[k] : k; };
  try { document.documentElement.lang = wahl; } catch (e) { /* egal */ }
})();
