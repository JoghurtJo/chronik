/* Werbeplätze: <cw-platz platz="…"></cw-platz>
   Gesteuert über CHRONIK_CONFIG.werbung (stufe 0–4). Gästeseiten und
   der Druck bleiben immer werbefrei. */
(function () {
  var W = (window.CHRONIK_CONFIG || {}).werbung || {};
  var STUFE = Math.max(0, Math.min(4, Number(W.stufe) || 0));
  /* ab = ab welcher Stufe der Platz gefüllt wird */
  var PLAETZE = {
    "zeitstrahl":    { ab: 2, titel: "Unter dem Zeitstrahl",        format: "horizontal", hoehe: 100 },
    "einstellungen": { ab: 2, titel: "Einstellungen, oben",          format: "horizontal", hoehe: 100 },
    "anmeldung":     { ab: 3, titel: "Anmeldeseite",                format: "horizontal", hoehe: 100 },
    "kontakte":      { ab: 3, titel: "Kontakte, unten",              format: "rectangle",  hoehe: 250 },
    "unten-fest":    { ab: 4, titel: "Fester Balken am Bildschirmrand", format: "horizontal", hoehe: 60, fest: true }
  };
  var KEY = "cw_zust";
  var zust = function () { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } };
  var adsenseGeladen = false;

  function adsenseLaden() {
    if (adsenseGeladen || !W.adsenseClient) return;
    adsenseGeladen = true;
    var s = document.createElement("script");
    s.async = true; s.crossOrigin = "anonymous";
    s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + encodeURIComponent(W.adsenseClient);
    document.head.appendChild(s);
  }
  function eigenesBanner(platz) {
    var liste = (W.eigeneBanner || []).filter(function (b) { return b && b.bild && (!b.plaetze || b.plaetze.indexOf(platz) >= 0); });
    return liste.length ? liste[Math.floor(Math.random() * liste.length)] : null;
  }

  var alle = [];
  function zustimmungsLeiste() {
    if (document.getElementById("cw-frage")) return;
    var d = document.createElement("div");
    d.id = "cw-frage"; d.setAttribute("data-noprint", "");
    d.setAttribute("style", "position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:400;max-width:620px;margin:0 auto;display:grid;gap:10px;padding:16px 18px;background:var(--color-bg,#f3f2f2);color:var(--color-text,#201e1d);box-shadow:var(--shadow-lg,0 8px 30px rgba(0,0,0,.18));border-radius:var(--radius-md,2px);font-family:var(--font-body,serif);font-size:15px;line-height:1.5;");
    d.innerHTML = '<div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--color-accent-700,#005f7c);">Werbung</div>' +
      "<div>" + (W.zustimmungText || "Diese Seite finanziert sich teilweise über Werbung. Darf dafür Google AdSense Cookies setzen und personalisierte Anzeigen zeigen?") + "</div>" +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;"><button data-w="ja" class="btn btn-primary" style="min-height:44px;">Einverstanden</button><button data-w="nein" class="btn btn-secondary" style="min-height:44px;">Ablehnen</button></div>';
    d.addEventListener("click", function (ev) {
      var w = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-w");
      if (!w) return;
      try { localStorage.setItem(KEY, w); } catch (e) { /* egal */ }
      d.remove();
      alle.forEach(function (el) { el.zeichnen(); });
    });
    document.body.appendChild(d);
  }

  class ChronikPlatz extends HTMLElement {
    connectedCallback() { alle.push(this); this.setAttribute("data-noprint", ""); this.zeichnen(); }
    disconnectedCallback() { var i = alle.indexOf(this); if (i >= 0) alle.splice(i, 1); }
    zeichnen() {
      var platz = this.getAttribute("platz") || "";
      var p = PLAETZE[platz];
      var aus = (W.plaetze || {})[platz] === false;
      this.innerHTML = "";
      this.style.display = "none";
      if (!p || aus || STUFE === 0 || (this.closest && this.closest('[data-screen-label="Gastbereich"]'))) return;
      var basis = "display:block;box-sizing:border-box;width:100%;";
      var fest = p.fest ? "position:fixed;left:0;right:0;bottom:0;z-index:80;padding:6px 12px calc(6px + env(safe-area-inset-bottom));background:var(--color-bg,#f3f2f2);box-shadow:var(--shadow-md,0 -2px 12px rgba(0,0,0,.12));" : "margin:12px 0;";
      /* Stufe 1: nur zeigen, wo Platz wäre */
      if (STUFE === 1) {
        this.style.cssText = basis + fest;
        this.innerHTML = '<div style="display:grid;place-items:center;gap:2px;min-height:' + Math.min(p.hoehe, 90) + 'px;padding:10px;box-sizing:border-box;border:2px dashed var(--color-accent-300,#8fcde3);color:var(--color-accent-700,#005f7c);font-family:var(--font-body,serif);text-align:center;">' +
          '<span style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;">Werbeplatz · ' + platz + " · ab Stufe " + p.ab + "</span>" +
          '<span style="font-size:13.5px;">' + p.titel + "</span></div>";
        return;
      }
      if (STUFE < p.ab) return;
      var anbieter = W.anbieter || "eigen";
      if (anbieter === "adsense" && W.adsenseClient && (W.adsensePlaetze || {})[platz]) {
        if (W.zustimmungFragen !== false && zust() !== "ja") {
          if (!zust()) zustimmungsLeiste();
          return this.eigenesZeigen(platz, basis + fest);
        }
        adsenseLaden();
        this.style.cssText = basis + fest;
        var ins = document.createElement("ins");
        ins.className = "adsbygoogle";
        ins.setAttribute("style", "display:block;width:100%;min-height:" + (p.fest ? 50 : 90) + "px;");
        ins.setAttribute("data-ad-client", W.adsenseClient);
        ins.setAttribute("data-ad-slot", W.adsensePlaetze[platz]);
        ins.setAttribute("data-ad-format", p.fest ? "horizontal" : "auto");
        ins.setAttribute("data-full-width-responsive", "true");
        this.appendChild(this.kennung());
        this.appendChild(ins);
        try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) { /* Blocker */ }
        return;
      }
      this.eigenesZeigen(platz, basis + fest);
    }
    kennung() {
      var k = document.createElement("div");
      k.textContent = W.kennzeichnung || "Anzeige";
      k.setAttribute("style", "font-family:var(--font-body,serif);font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--color-neutral-700,#5d5a58);margin-bottom:4px;");
      return k;
    }
    eigenesZeigen(platz, stil) {
      var b = eigenesBanner(platz);
      if (!b) return;
      this.style.cssText = stil;
      this.appendChild(this.kennung());
      var a = document.createElement("a");
      a.href = b.link || "#"; a.target = "_blank"; a.rel = "sponsored noopener";
      a.setAttribute("style", "display:block;line-height:0;");
      var img = document.createElement("img");
      img.src = b.bild; img.alt = b.text || "Anzeige"; img.loading = "lazy";
      img.setAttribute("style", "display:block;width:100%;height:auto;max-height:" + PLAETZE[platz].hoehe + "px;object-fit:contain;");
      a.appendChild(img);
      this.appendChild(a);
    }
  }
  if (!customElements.get("cw-platz")) customElements.define("cw-platz", ChronikPlatz);
  window.ChronikPlatz = { stufe: STUFE, plaetze: PLAETZE, zustimmungZuruecksetzen: function () { try { localStorage.removeItem(KEY); } catch (e) {} location.reload(); } };
})();
