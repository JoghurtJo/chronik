/* Feedback-Knopf: kleine Lasche am rechten Rand, öffnet ein Formular.
   Angemeldete sehen außerdem ihre Meldungen samt Antworten des Teams. */
(function () {
  var t = function (k) { return window.tx ? window.tx(k) : k; };
  var CC = function () { return window.ChronikCloud; };
  var ARTEN = ["idee", "fehler", "frage", "lob", "sonst"];
  var st = { auf: false, tab: "neu", art: "idee", text: "", email: "", info: true, busy: false, msg: "", fehler: "", meine: [], angemeldet: false, ungelesen: 0, nachtrag: {} };
  var root, knopf, punkt;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function zeit(z) { try { return new Date(z).toLocaleString(window.CHRONIK_LOCALE || "de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }
  function ungelesen(m) {
    var g = m.gesehen ? new Date(m.gesehen).getTime() : 0;
    return (m.antworten || []).some(function (a) { return a.von === "team" && new Date(a.zeit).getTime() > g; }) || (m.reaktion && new Date(m.geaendert).getTime() > g);
  }
  function geraet() {
    var n = navigator, b = /Brave/.test(n.userAgent) || (n.brave ? "Brave" : "");
    return [n.userAgent.slice(0, 260), (b ? "Brave" : ""), screen.width + "×" + screen.height, window.innerWidth + "×" + window.innerHeight, n.language].filter(Boolean).join(" · ");
  }
  function seite() {
    var offen = Array.prototype.slice.call(document.querySelectorAll("[data-screen-label]")).map(function (e) { return e.getAttribute("data-screen-label"); }).filter(function (x, i, a) { return a.indexOf(x) === i; }).slice(-3).join(" › ");
    return (location.pathname.split("/").pop() || "index") + (offen ? " · " + offen : "");
  }

  async function laden() {
    var c = CC(); if (!c || !c.enabled) return;
    try {
      var s = await c.session();
      st.angemeldet = !!s;
      if (!s) { st.meine = []; st.ungelesen = 0; return malen(); }
      st.meine = await c.feedbackMeine();
      st.ungelesen = st.meine.filter(ungelesen).length;
    } catch (e) { /* still */ }
    malen();
  }
  async function senden() {
    if (st.busy || st.text.trim().length < 2) return;
    st.busy = true; st.fehler = ""; malen();
    try {
      await CC().feedbackSenden(st.art, st.text.trim(), st.info ? seite() : "", st.info ? geraet() : "", st.angemeldet ? "" : st.email.trim());
      st.text = ""; st.msg = st.angemeldet ? t("fb_danke") : t("fb_danke_gast");
      if (st.angemeldet) await laden();
    } catch (e) {
      st.fehler = e && e.code === "F-05" ? t("fb_f_viel") : e && e.code === "F-06" ? t("fb_f_fehlt") : t("fb_f_senden");
    }
    st.busy = false; malen();
  }
  async function nachtragen(id) {
    var txt = String(st.nachtrag[id] || "").trim(); if (!txt) return;
    try { await CC().feedbackNachtrag(id, txt); st.nachtrag[id] = ""; await laden(); } catch (e) { st.fehler = t("fb_f_senden"); malen(); }
  }
  function oeffnen() {
    st.auf = true; st.msg = ""; st.fehler = "";
    st.tab = st.ungelesen ? "meine" : "neu";
    malen(); laden();
    if (st.ungelesen) { gesehenMelden(); }
    setTimeout(function () { var ta = root.querySelector("textarea[data-fb=text]"); if (ta && st.tab === "neu") ta.focus(); }, 30);
  }
  function gesehenMelden() { try { var c = CC(); if (c && c.enabled) { var p = c.feedbackGesehen(); if (p && p.catch) p.catch(function () {}); } } catch (e) {} }
  function schliessen() { st.auf = false; if (st.tab === "meine") st.ungelesen = 0; malen(); }

  var KICK = "font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--color-accent-700);";
  function chip(an) {
    return "display:inline-flex;align-items:center;min-height:40px;padding:0 14px;border-radius:999px;cursor:pointer;font:inherit;font-size:14.5px;" +
      (an ? "background:var(--color-accent);color:#fff;border:1px solid var(--color-accent);" : "background:transparent;color:var(--color-text);border:1px solid var(--color-neutral-300);");
  }
  function malen() {
    if (!root) return;
    punkt.style.display = st.ungelesen ? "block" : "none";
    if (!st.auf) { root.querySelector("[data-fb=dlg]") && root.querySelector("[data-fb=dlg]").remove(); return; }
    var alt = root.querySelector("[data-fb=dlg]");
    var scroll = alt ? (alt.querySelector("[data-fb=panel]") || {}).scrollTop : 0;
    var html = '<div data-fb="dlg" data-noprint="" style="position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:16px;background:color-mix(in srgb,var(--color-text) 40%,transparent);">' +
      '<div data-fb="panel" role="dialog" aria-modal="true" aria-label="' + esc(t("fb_kicker")) + '" style="width:min(520px,100%);max-height:calc(100dvh - 32px);overflow-y:auto;box-sizing:border-box;padding:24px;background:var(--color-bg);color:var(--color-text);box-shadow:var(--shadow-lg);border-radius:var(--radius-lg);display:grid;gap:14px;font-family:var(--font-body);">' +
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;"><div><div style="' + KICK + '">' + esc(t("fb_kicker")) + '</div>' +
      '<h2 style="margin:3px 0 0;font-size:26px;line-height:1.1;font-family:var(--font-heading);">' + esc(t("fb_titel")) + "</h2></div>" +
      '<button data-fb="zu" class="btn btn-ghost btn-icon" aria-label="' + esc(t("fb_zu")) + '" style="min-width:44px;min-height:44px;font-size:18px;">✕</button></div>';
    if (st.angemeldet) {
      html += '<div class="seg" style="display:flex;gap:6px;">' +
        '<button data-fb="tab" data-v="neu" style="' + chip(st.tab === "neu") + '">' + esc(t("fb_neu")) + "</button>" +
        '<button data-fb="tab" data-v="meine" style="' + chip(st.tab === "meine") + '">' + esc(t("fb_meine")) + (st.meine.length ? " · " + st.meine.length : "") + (st.ungelesen ? ' <span style="display:inline-block;width:8px;height:8px;margin-left:6px;border-radius:50%;background:var(--color-accent-2);"></span>' : "") + "</button></div>";
    }
    if (st.tab === "neu" || !st.angemeldet) {
      html += '<div style="font-size:14px;line-height:1.5;color:var(--color-neutral-700);">' + esc(t("fb_sub")) + "</div>" +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + ARTEN.map(function (a) { return '<button data-fb="art" data-v="' + a + '" aria-pressed="' + (st.art === a) + '" style="' + chip(st.art === a) + '">' + esc(t("fb_" + a)) + "</button>"; }).join("") + "</div>" +
        '<textarea data-fb="text" class="input" rows="5" maxlength="4000" placeholder="' + esc(t(st.art === "fehler" ? "fb_text_ph_fehler" : "fb_text_ph")) + '" style="font-size:16px;resize:vertical;">' + esc(st.text) + "</textarea>" +
        (st.angemeldet ? "" : '<input data-fb="email" class="input" type="email" autocomplete="email" placeholder="' + esc(t("fb_email")) + '" value="' + esc(st.email) + '" style="font-size:16px;">') +
        '<label style="display:flex;gap:10px;align-items:center;font-size:14px;cursor:pointer;min-height:44px;"><input data-fb="info" type="checkbox"' + (st.info ? " checked" : "") + ' style="width:20px;height:20px;accent-color:var(--color-accent);">' + esc(t("fb_mit_info")) + "</label>" +
        (st.msg ? '<div role="status" style="font-size:14.5px;color:var(--color-accent-700);">' + esc(st.msg) + "</div>" : "") +
        (st.fehler ? '<div role="alert" style="font-size:14.5px;color:var(--color-accent-2-700);">' + esc(st.fehler) + "</div>" : "") +
        '<div style="display:flex;gap:8px;"><button data-fb="senden" class="btn btn-primary" style="min-height:44px;"' + (st.busy || st.text.trim().length < 2 ? " disabled" : "") + ">" + esc(t("fb_senden")) + "</button></div>";
    } else {
      if (!st.meine.length) html += '<div style="font-size:14.5px;color:var(--color-neutral-700);">' + esc(t("fb_leer")) + "</div>";
      st.meine.forEach(function (m) {
        var neu = ungelesen(m);
        html += '<div style="display:grid;gap:8px;padding:14px 0;border-top:1px solid var(--color-neutral-200);">' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12.5px;color:var(--color-neutral-700);">' +
          '<span class="tag tag-neutral">' + esc(t("fb_" + m.kind)) + '</span><span class="tag ' + (m.status === "erledigt" ? "tag-accent" : "tag-outline") + '">' + esc(t("fb_st_" + m.status)) + "</span>" +
          (neu ? '<span class="tag tag-accent-2">' + esc(t("fb_ungelesen")) + "</span>" : "") + "<span>" + esc(zeit(m.created)) + "</span>" +
          (m.reaktion ? '<span style="font-size:18px;margin-left:auto;" title="' + esc(t("fb_team")) + '">' + esc(m.reaktion) + "</span>" : "") + "</div>" +
          '<div style="font-size:15px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;">' + esc(m.text) + "</div>" +
          (m.antworten || []).map(function (a) {
            var team = a.von === "team";
            return '<div style="display:grid;gap:2px;padding:8px 12px;border-radius:var(--radius-md);background:' + (team ? "var(--color-accent-100)" : "var(--color-neutral-100)") + ';">' +
              '<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:' + (team ? "var(--color-accent-800)" : "var(--color-neutral-700)") + ';">' + esc(team ? t("fb_team") : t("fb_du")) + " · " + esc(zeit(a.zeit)) + "</div>" +
              '<div style="font-size:14.5px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;">' + esc(a.text) + "</div></div>";
          }).join("") +
          '<div style="display:flex;gap:8px;align-items:flex-end;"><textarea data-fb="nt" data-id="' + m.id + '" class="input" rows="1" placeholder="' + esc(t("fb_nachtrag_ph")) + '" style="flex:1;min-width:0;font-size:16px;resize:vertical;">' + esc(st.nachtrag[m.id] || "") + "</textarea>" +
          '<button data-fb="ntsend" data-id="' + m.id + '" class="btn btn-secondary" style="min-height:44px;white-space:nowrap;">' + esc(t("fb_nachtrag")) + "</button></div></div>";
      });
      if (st.fehler) html += '<div role="alert" style="font-size:14.5px;color:var(--color-accent-2-700);">' + esc(st.fehler) + "</div>";
    }
    html += "</div></div>";
    if (alt) alt.remove();
    root.insertAdjacentHTML("beforeend", html);
    var p = root.querySelector("[data-fb=panel]"); if (p && scroll) p.scrollTop = scroll;
  }

  function aufbauen() {
    root = document.createElement("div");
    root.setAttribute("data-noprint", "");
    root.id = "fb-wurzel";
    knopf = document.createElement("button");
    knopf.type = "button";
    knopf.setAttribute("aria-label", t("fb_knopf"));
    knopf.setAttribute("style", "position:fixed;right:0;top:42%;z-index:55;display:flex;align-items:center;gap:6px;padding:12px 8px;min-width:36px;border:0;border-radius:var(--radius-md) 0 0 var(--radius-md);background:var(--color-text);color:var(--color-bg);font:inherit;font-family:var(--font-body);font-size:13px;letter-spacing:.12em;text-transform:uppercase;writing-mode:vertical-rl;transform:rotate(180deg);cursor:pointer;box-shadow:var(--shadow-md);opacity:.88;");
    knopf.innerHTML = '<i class="ph-duotone ph-chat-circle-text" style="font-size:18px;transform:rotate(90deg);"></i><span>' + esc(t("fb_knopf")) + "</span>";
    punkt = document.createElement("span");
    punkt.setAttribute("style", "position:absolute;left:-4px;bottom:-4px;width:12px;height:12px;border-radius:50%;background:var(--color-accent-2);border:2px solid var(--color-bg);display:none;");
    knopf.appendChild(punkt);
    knopf.addEventListener("mouseenter", function () { knopf.style.opacity = "1"; });
    knopf.addEventListener("mouseleave", function () { knopf.style.opacity = ".88"; });
    knopf.addEventListener("click", oeffnen);
    root.appendChild(knopf);
    root.addEventListener("click", function (ev) {
      var el = ev.target.closest("[data-fb]"); if (!el) return;
      var w = el.getAttribute("data-fb");
      if (w === "dlg" && ev.target === el) return schliessen();
      if (w === "zu") return schliessen();
      if (w === "tab") { st.tab = el.getAttribute("data-v"); st.fehler = ""; if (st.tab === "meine") { gesehenMelden(); } return malen(); }
      if (w === "art") { st.art = el.getAttribute("data-v"); return malen(); }
      if (w === "senden") return senden();
      if (w === "ntsend") return nachtragen(el.getAttribute("data-id"));
    });
    root.addEventListener("input", function (ev) {
      var w = ev.target.getAttribute && ev.target.getAttribute("data-fb");
      if (w === "text") { st.text = ev.target.value; st.msg = ""; var b = root.querySelector("[data-fb=senden]"); if (b) b.disabled = st.busy || st.text.trim().length < 2; }
      if (w === "email") st.email = ev.target.value;
      if (w === "nt") st.nachtrag[ev.target.getAttribute("data-id")] = ev.target.value;
    });
    root.addEventListener("change", function (ev) { if (ev.target.getAttribute("data-fb") === "info") st.info = ev.target.checked; });
    document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && st.auf) schliessen(); });
    document.body.appendChild(root);
  }
  /* Nicht auf Gästeseiten, nicht in der Fotoshow und ohne Cloud. */
  function sichtbarkeit() {
    var c = CC();
    var weg = !c || !c.enabled || document.querySelector('[data-screen-label="Gastbereich"],[data-screen-label="Fotoshow"]');
    knopf.style.display = weg ? "none" : "flex";
  }
  function start() {
    aufbauen(); sichtbarkeit(); laden();
    setInterval(sichtbarkeit, 1200);
    setInterval(function () { if (!st.auf) laden(); }, 5 * 60 * 1000);
    var c = CC();
    if (c && c.enabled && c.onAuth) { try { var p = c.onAuth(function () { setTimeout(laden, 400); }); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
