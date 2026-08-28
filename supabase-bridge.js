/* Chronik ↔ Supabase  */
(function () {
  var CFG = window.CHRONIK_CONFIG || {};
  var SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js";
  var BUCKET = "bilder";

  function cleanUrl(v) {
    var u = String(v || "").trim().replace(/^["']|["']$/g, "");
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    u = u.replace(/\/+$/, "");
    u = u.replace(/\/(rest|auth|storage|realtime)\/v1.*$/i, "");
    u = u.replace(/\/+$/, "");
    return u;
  }

  var URL_OK = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i;
  var KEY_OK = /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

  var rawUrl = String(CFG.url || "").trim();
  var rawKey = String(CFG.anonKey || "").trim().replace(/^["']|["']$/g, "");
  var url = cleanUrl(rawUrl);

  var configFault = "";
  if (rawUrl || rawKey) {
    if (!rawUrl) configFault = "V-05";
    else if (!URL_OK.test(url)) configFault = "V-02";
    else if (!rawKey) configFault = "V-06";
    else if (!KEY_OK.test(rawKey)) configFault = "V-03";
  }

  var enabled = !!(url && rawKey && !configFault);
  var R2 = cleanUrl(CFG.r2Worker).replace(/\/(upload|img|state).*$/i, "");
  var LIM = Object.assign({
    dbRows: 4000, writesPerDay: 1500, readsPerDay: 8000, uploadsPerDay: 300,
    getsPerDay: 50000, storageBytes: 8000000000, egressPerMonth: 4000000000, emailsPerHour: 3
  }, CFG.limits || {});
  var sb = null, loading = null, snap = null, snapAt = 0;
  var urlCache = {};
  var legacySchema = false;
  var lastR2Error = "";

  function loadSdk() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = SDK;
      s.onload = res;
      s.onerror = function () { rej(fail("V-04")); };
      document.head.appendChild(s);
    });
    return loading;
  }

  async function client() {
    if (!enabled) throw fail(configFault || "V-01");
    if (sb) return sb;
    await loadSdk();
    sb = window.supabase.createClient(url, rawKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return sb;
  }

  function fail(c, cause) {
    var e = new Error(c);
    e.code = c;
    if (cause) e.cause = cause;
    return e;
  }

  function code(e) {
    if (e && e.code && /^[A-Z]-\d\d$/.test(e.code)) return e.code;
    var t = String((e && e.message) || e || "");
    if (/^[A-Z]-\d\d$/.test(t)) return t;
    if (/Invalid login credentials/i.test(t)) return "A-10";
    if (/Email not confirmed/i.test(t)) return "A-12";
    if (/User already registered|already been registered/i.test(t)) return "A-04";
    if (/captcha/i.test(t)) return "A-14";
    if (/rate limit|too many|Email rate/i.test(t)) return "A-11";
    if (/row-level security|violates row-level/i.test(t)) return "D-02";
    if (/duplicate key|profiles_username/i.test(t)) return "A-02";
    if (/Password should be at least/i.test(t)) return "A-05";
    if (/schema cache|column .* does not exist|Could not find the/i.test(t)) return "D-01";
    if (/Error sending confirmation email|error sending.*email|smtp/i.test(t)) return "A-13";
    if (/invalid path|no Route matched/i.test(t)) return "V-02";
    if (/Invalid API key|JWSError|JWT/i.test(t)) return "V-03";
    if (/Failed to fetch|NetworkError|Load failed/i.test(t)) return "V-04";
    if (/not found/i.test(t)) return "D-04";
    return "X-99";
  }

  function msg(e) { return code(e); }


  /* ---------------- Grenzen ---------------- */

  function fmtBytes(n) {
    n = Number(n || 0);
    if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
    if (n >= 1e6) return Math.round(n / 1e6) + " MB";
    return Math.round(n / 1000) + " KB";
  }

  async function snapshot(force) {
    if (!enabled) return null;
    if (!force && snap && Date.now() - snapAt < 20000) return snap;
    var c = await client();
    var r = await c.rpc("usage_snapshot");
    if (r.error) return snap;
    snap = r.data || null;
    snapAt = Date.now();
    return snap;
  }

  function tomorrow() {
    var d = new Date(); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0);
    return d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
  }
  function nextMonth(s) {
    var d = s && s.month_end ? new Date(s.month_end) : new Date();
    return d.toLocaleDateString("de-DE", { day: "numeric", month: "long" });
  }

  /* Darf diese Aktion starten? kind: write | read | upload | get | row */
  function check(kind, s, extraBytes) {
    if (!s) return null;
    var day = s.day || {}, month = s.month || {};
    var rows = Number(s.rows || 0);
    if (kind === "row" && rows >= LIM.dbRows) {
      return { scope: "ereignisse", message: "Die Chronik hat mit " + rows + " Ereignissen ihr Gratis-Fassungsvermögen erreicht. Neue Ereignisse gehen erst wieder, wenn alte gelöscht werden — oder wenn der Speicher erweitert wird.", again: "" };
    }
    if ((kind === "write" || kind === "row") && Number(day.writes || 0) >= LIM.writesPerDay) {
      return { scope: "speichern", message: "Für heute wurde schon sehr viel gespeichert (" + day.writes + " Änderungen). Das ist die Tagesgrenze des Gratis-Tarifs.", again: "Ab morgen, " + tomorrow() + ", geht es wieder." };
    }
    if (kind === "read" && Number(day.reads || 0) >= LIM.readsPerDay) {
      return { scope: "laden", message: "Die Chronik wurde heute außergewöhnlich oft geladen. Damit keine Kosten entstehen, macht sie jetzt Pause.", again: "Ab morgen, " + tomorrow() + ", ist alles wie gewohnt da." };
    }
    if (kind === "upload") {
      if (Number(s.bytes || 0) + Number(extraBytes || 0) > LIM.storageBytes) {
        return { scope: "fotospeicher", message: "Der Fotospeicher ist voll (" + fmtBytes(s.bytes) + " von " + fmtBytes(LIM.storageBytes) + "). Neue Bilder passen erst hinein, wenn alte gelöscht werden.", again: "" };
      }
      if (Number(day.uploads || 0) >= LIM.uploadsPerDay) {
        return { scope: "bilder-heute", message: "Für heute sind genug Bilder hochgeladen (" + day.uploads + "). So bleibt der Gratis-Tarif eingehalten.", again: "Ab morgen, " + tomorrow() + ", kannst du weitermachen." };
      }
    }
    if (kind === "get" && Number(day.gets || 0) >= LIM.getsPerDay) {
      return { scope: "bilder-anzeigen", message: "Heute wurden sehr viele Bilder angezeigt. Die Chronik zeigt bis morgen nur noch Texte.", again: "Ab morgen, " + tomorrow() + ", sind die Bilder wieder da." };
    }
    if (Number(month.bytes_out || 0) >= LIM.egressPerMonth) {
      return { scope: "datenverkehr", message: "Der Datenverkehr dieses Monats ist aufgebraucht (" + fmtBytes(month.bytes_out) + "). Damit nichts kostet, ruht die Chronik bis zum Monatswechsel.", again: "Ab " + nextMonth(s) + " geht es weiter." };
    }
    return null;
  }

  async function guard(kind, extraBytes) {
    var s = await snapshot(false);
    var block = check(kind, s, extraBytes);
    return block ? { ok: false, block: block } : { ok: true };
  }

  async function bump(patch) {
    try {
      var c = await client();
      await c.rpc("bump_usage", patch);
      snapAt = 0;
    } catch (e) { /* Zähler sind kein Grund, etwas abzubrechen */ }
  }

  function budget(s) {
    if (!s) return null;
    var day = s.day || {}, month = s.month || {};
    return {
      rows: { used: Number(s.rows || 0), cap: LIM.dbRows },
      writes: { used: Number(day.writes || 0), cap: LIM.writesPerDay },
      uploads: { used: Number(day.uploads || 0), cap: LIM.uploadsPerDay },
      gets: { used: Number(day.gets || 0), cap: LIM.getsPerDay },
      bytes: { used: Number(s.bytes || 0), cap: LIM.storageBytes, label: fmtBytes(s.bytes) + " von " + fmtBytes(LIM.storageBytes) },
      egress: { used: Number(month.bytes_out || 0), cap: LIM.egressPerMonth, label: fmtBytes(month.bytes_out) + " von " + fmtBytes(LIM.egressPerMonth) }
    };
  }

  /* ---------------- Konten ---------------- */

  async function emailTaken(email) {
    try {
      var c = await client();
      var r = await c.rpc("email_taken", { p_email: String(email || "").trim() });
      if (r.error) return false;
      return !!r.data;
    } catch (e) { return false; }
  }

  async function nameTaken(name) {
    try {
      var c = await client();
      var r = await c.from("profiles").select("id").ilike("username", String(name || "").trim()).limit(1);
      if (r.error) return false;
      return (r.data || []).length > 0;
    } catch (e) { return false; }
  }

  async function signUp(email, pw, username, captchaToken) {
    var c = await client();
    if (await emailTaken(email)) throw fail("A-04");
    if (await nameTaken(username)) throw fail("A-02");
    var opts = { data: { username: username }, emailRedirectTo: backHere() };
    if (captchaToken) opts.captchaToken = captchaToken;
    var r = await c.auth.signUp({ email: email, password: pw, options: opts });
    if (r.error) throw fail(code(r.error));
    bump({ p_emails: 1 });
    return { session: r.data.session, needsConfirm: !r.data.session };
  }

  /* Zum Benutzernamen die hinterlegte Adresse suchen. */
  async function emailForName(name) {
    try {
      var c = await client();
      var r = await c.from("profiles").select("email").ilike("username", String(name || "").trim()).limit(1);
      if (r.error) return "";
      return (r.data && r.data[0] && r.data[0].email) || "";
    } catch (e) { return ""; }
  }

  async function signIn(id, pw, captchaToken) {
    var c = await client();
    var email = String(id || "").trim();
    if (email.indexOf("@") < 0) {
      var gefunden = await emailForName(email);
      if (!gefunden) throw fail("A-10");
      email = gefunden;
    }
    var opts = captchaToken ? { captchaToken: captchaToken } : undefined;
    var r = await c.auth.signInWithPassword({ email: email, password: pw, options: opts });
    if (r.error) throw fail(code(r.error));
    return r.data.session;
  }

  async function signOut() { var c = await client(); await c.auth.signOut(); }

  async function session() {
    var c = await client();
    var r = await c.auth.getSession();
    return (r.data && r.data.session) || null;
  }

  async function token() {
    var s = await session();
    if (!s) return "";
    var soon = s.expires_at && (s.expires_at * 1000 - Date.now() < 90000);
    if (soon) {
      try {
        var c = await client();
        var r = await c.auth.refreshSession();
        if (r && r.data && r.data.session) s = r.data.session;
      } catch (e) { /* altes Ticket weiterverwenden */ }
    }
    return s.access_token || "";
  }

  function backHere() {
    var u = location.origin + location.pathname;
    if (/\/$/.test(u)) u = u + "index.html";
    return u;
  }

  async function sendReset(email) {
    var c = await client();
    var r = await c.auth.resetPasswordForEmail(email, { redirectTo: backHere() });
    if (r.error) throw fail(code(r.error));
    bump({ p_emails: 1 });
    return true;
  }

  async function updatePassword(pw) {
    var c = await client();
    var r = await c.auth.updateUser({ password: pw });
    if (r.error) throw fail(code(r.error));
    return true;
  }

  function recoveryPending() { return /type=recovery/.test(location.hash || ""); }

  function hashToken() {
    var h = String(location.hash || "").replace(/^#/, "");
    var m = h.match(/access_token=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  /* Sekunden seit Ausstellung des Links. -1 = unbekannt. */
  function linkAge() {
    try {
      var t = hashToken();
      if (!t) return -1;
      var teil = t.split(".")[1];
      if (!teil) return -1;
      var roh = teil.replace(/-/g, "+").replace(/_/g, "/");
      while (roh.length % 4) roh += "=";
      var p = JSON.parse(atob(roh));
      if (!p || !p.iat) return -1;
      return Math.floor(Date.now() / 1000) - Number(p.iat);
    } catch (e) { return -1; }
  }

  async function sessionEmail() {
    var s = await session();
    return (s && s.user && s.user.email) || "";
  }

  /* Nach einer Passwortänderung: Sicherheitsmail an dieselbe Adresse.
     Sie enthält einen frischen Link, mit dem sich die Änderung sofort
     überschreiben lässt, falls sie nicht vom Kontoinhaber kam. */
  async function notifyChange(email) {
    if (!email) return { ok: false, reason: "keine-adresse" };
    var c;
    try { c = await client(); } catch (e) { return { ok: false, reason: "keine-verbindung" }; }

    async function versuch() {
      try {
        var r = await c.auth.resetPasswordForEmail(email, { redirectTo: backHere() });
        if (!r.error) return { ok: true };
        var t = String(r.error.message || "");
        var sperre = r.error.status === 429 || /rate limit|too many|security purposes|seconds/i.test(t);
        return { ok: false, reason: sperre ? "sperrfrist" : "fehler", detail: t };
      } catch (e) {
        return { ok: false, reason: "fehler", detail: String((e && e.message) || e) };
      }
    }

    var a = await versuch();
    if (a.ok) { bump({ p_emails: 1 }); return a; }
    /* Supabase sperrt Recovery-Mails kurz pro Adresse. Nicht warten —
       der Versuch läuft im Hintergrund weiter, damit die Oberfläche
       nicht minutenlang hängt. */
    if (a.reason === "sperrfrist") {
      setTimeout(function () {
        versuch().then(function (z) { if (z.ok) bump({ p_emails: 1 }); });
      }, 62000);
      return { ok: false, reason: "sperrfrist", spaeter: true };
    }
    return a;
  }

  async function onAuth(cb) {
    var c = await client();
    c.auth.onAuthStateChange(function (evt, s) { cb(evt, s); });
  }

  async function profiles() {
    var c = await client();
    var r = await c.from("profiles").select("id, username, email, role, blocked, look, notify").order("username");
    if (r.error && /look|notify/i.test(String(r.error.message || ""))) {
      r = await c.from("profiles").select("id, username, email, role, blocked").order("username");
    }
    if (r.error) throw fail(code(r.error));
    return (r.data || []).map(function (p) {
      return {
        id: p.id, username: p.username || (p.email || "").split("@")[0],
        email: p.email || "", role: p.role || "member", blocked: !!p.blocked,
        look: p.look || {}, notify: p.notify || {}
      };
    });
  }

  async function setBlocked(userId, blocked) {
    var c = await client();
    var r = await c.rpc("set_blocked", { p_user: userId, p_blocked: !!blocked });
    if (r.error) throw fail(code(r.error));
  }

  /* ---------------- Verlauf ---------------- */

  /* ---------- Kontakte ---------- */

  async function friends() {
    var c = await client();
    var r = await c.from("contacts").select("id, asker, askee, status");
    if (r.error) throw fail(code(r.error));
    return (r.data || []).map(function (x) {
      return { id: x.id, from: x.asker, to: x.askee, status: x.status || "pending" };
    });
  }

  async function askFriend(otherId) {
    var c = await client();
    var r = await c.from("contacts").insert({ askee: otherId }).select("id");
    if (r.error) throw fail(code(r.error));
    bump({ p_writes: 1 });
    return (r.data && r.data[0] && r.data[0].id) || null;
  }

  async function answerFriend(id, accept) {
    var c = await client();
    var r = accept
      ? await c.from("contacts").update({ status: "accepted" }).eq("id", id)
      : await c.from("contacts").delete().eq("id", id);
    if (r.error) throw fail(code(r.error));
    bump({ p_writes: 1 });
  }

  async function unfriend(id) {
    var c = await client();
    var r = await c.from("contacts").delete().eq("id", id);
    if (r.error) throw fail(code(r.error));
    bump({ p_writes: 1 });
  }

  /* Aussehen und Titel gehören zur Person und reisen mit aufs nächste Gerät. */
  async function saveLook(look) {
    var c = await client();
    var s = await c.auth.getUser();
    var id = s && s.data && s.data.user && s.data.user.id;
    if (!id) return;
    var r = await c.from("profiles").update({ look: look || {} }).eq("id", id);
    if (r.error && !/look/i.test(String(r.error.message || ""))) throw fail(code(r.error));
  }

  async function removeComment(id) {
    var c = await client();
    var r = await c.from("comments").update({ deleted: true, text: "" }).eq("id", id);
    if (r.error) throw fail(code(r.error));
    bump({ p_writes: 1 });
  }

  /* ---------- Benachrichtigungen ---------- */

  async function saveNotify(prefs) {
    var c = await client();
    var s = await session();
    if (!s || !s.user) return false;
    var r = await c.from("profiles").update({ notify: prefs || {} }).eq("id", s.user.id);
    if (r.error) throw fail(code(r.error));
    bump({ p_writes: 1 });
    return true;
  }

  /* Mail an eine andere Person. Der Worker verschickt sie;
     ohne eingerichteten Mailschlüssel passiert einfach nichts. */
  async function notify(empfaengerId, art, betreff, text) {
    if (!R2) return { ok: false, reason: "kein-worker" };
    try {
      var tk = await token();
      if (!tk) return { ok: false, reason: "keine-anmeldung" };
      var res = await fetch(R2 + "/notify", {
        method: "POST",
        headers: { Authorization: "Bearer " + tk, "content-type": "application/json" },
        body: JSON.stringify({ to: empfaengerId, kind: art, subject: betreff, text: text })
      });
      var out = await res.json().catch(function () { return {}; });
      return { ok: !!res.ok && !!out.ok, reason: out.error || "", status: res.status };
    } catch (e) {
      return { ok: false, reason: "nicht-erreichbar" };
    }
  }

  async function groups() {
    var c = await client();
    var r = await c.from("groups").select("id, name, members").order("name");
    if (r.error) throw fail(code(r.error));
    return (r.data || []).map(function (g) { return { id: g.id, name: g.name || "", members: g.members || [] }; });
  }

  async function saveGroup(g) {
    var c = await client();
    var row = { name: g.name || "", members: g.members || [] };
    var r = g.id && String(g.id).length > 20
      ? await c.from("groups").update(row).eq("id", g.id).select("id")
      : await c.from("groups").insert(row).select("id");
    if (r.error) throw fail(code(r.error));
    bump({ p_writes: 1 });
    return (r.data && r.data[0] && r.data[0].id) || g.id;
  }

  async function removeGroup(id) {
    var c = await client();
    var r = await c.from("groups").delete().eq("id", id);
    if (r.error) throw fail(code(r.error));
    bump({ p_writes: 1 });
  }

  async function history(limit) {
    var c = await client();
    var r = await c.from("event_history")
      .select("id, event_id, action, actor, at, undone, snapshot")
      .order("at", { ascending: false }).limit(limit || 40);
    if (r.error) throw fail(code(r.error));
    return (r.data || []).map(function (h) {
      return {
        id: h.id, eventId: h.event_id, action: h.action, actor: h.actor,
        at: h.at, undone: !!h.undone,
        name: (h.snapshot && h.snapshot.name) || "Ohne Titel"
      };
    });
  }

  async function undo(id) {
    var c = await client();
    var r = await c.rpc("undo_change", { p_id: id });
    if (r.error) throw fail(code(r.error));
    bump({ p_writes: 1 });
  }

  /* ---------------- Ereignisse ---------------- */

  function rowToEvent(row, comments, urls) {
    var d = row.data || {};
    var imgs = (d.images || []).map(function (im, i) {
      var src = im.src || (im.key ? (urls[im.key] || "") : (im.path ? (urls[im.path] || "") : ""));
      return {
        src: src, key: im.key || "", path: im.path || "", caption: im.caption || "",
        comments: comments[row.id + ":" + i] || []
      };
    });
    return {
      id: row.id, by: row.owner, name: row.name || "", date: row.date || "", end: row.end_date || "",
      place: row.place || "", kicker: row.kicker || "", note: d.note || "",
      infos: d.infos || [], people: d.people || [], images: imgs,
      deco: d.deco || { fx: [], pal: "thema", stickers: [] },
      vis: (row.vis === "selected" ? "people" : row.vis) || "private", who: row.who || [], gwho: row.gwho || [], perms: row.perms || {}, share: row.share || "view",
      changedBy: row.changed_by || ""
    };
  }

  function eventToRow(e) {
    return {
      name: e.name || "", date: e.date || null, end_date: e.end || null,
      place: e.place || "", kicker: e.kicker || "",
      vis: e.vis || "private", who: e.who || [], gwho: e.gwho || [], perms: e.perms || {}, share: e.share || "view",
      data: {
        note: e.note || "", infos: e.infos || [], people: e.people || [], deco: e.deco || null,
        images: (e.images || []).map(function (im) {
          if (im.key) return { key: im.key, caption: im.caption || "" };
          if (im.path) return { path: im.path, caption: im.caption || "" };
          return { src: im.src || "", caption: im.caption || "" };
        })
      }
    };
  }

  async function loadEvents() {
    var g = await guard("read");
    if (!g.ok) { var err = new Error(g.block.message); err.block = g.block; throw err; }

    var c = await client();
    var ev = await c.from("events").select("*").order("date");
    if (ev.error) throw fail(code(ev.error));
    var rows = ev.data || [];

    var cm = await c.from("comments").select("id, event_id, image_index, text, deleted, author, created_at, profiles(username)").order("created_at");
    if (cm.error && /deleted|author/i.test(String(cm.error.message || ""))) {
      cm = await c.from("comments").select("id, event_id, image_index, text, created_at, profiles(username)").order("created_at");
    }
    var byKey = {};
    (cm.data || []).forEach(function (r) {
      var k = r.event_id + ":" + (r.image_index || 0);
      (byKey[k] = byKey[k] || []).push({
        id: r.id,
        userId: r.author || "",
        who: (r.profiles && r.profiles.username) || "jemand",
        text: r.deleted ? "" : r.text,
        deleted: !!r.deleted
      });
    });

    /* Bild-Adressen besorgen: R2 über den Worker, sonst Supabase-Speicher */
    var urls = {};
    var r2keys = [], spaths = [];
    rows.forEach(function (r) {
      ((r.data || {}).images || []).forEach(function (im) {
        if (im.key) r2keys.push(im.key); else if (im.path) spaths.push(im.path);
      });
    });
    /* Ältere Bilder, die noch im Supabase-Speicher liegen, bleiben sichtbar.
       Neue Bilder gehen ausschließlich nach Cloudflare R2. */
    if (spaths.length) {
      try {
        var sg = await c.storage.from(BUCKET).createSignedUrls(spaths, 60 * 60 * 12);
        (sg.data || []).forEach(function (s) { if (s.path && s.signedUrl) urls[s.path] = s.signedUrl; });
      } catch (e) { /* Speicher nicht vorhanden: Bild bleibt leer */ }
    }
    if (r2keys.length && R2) {
      var gg = await guard("get");
      if (gg.ok) {
        var tk = await token();
        for (var i = 0; i < r2keys.length; i++) {
          var k = r2keys[i];
          if (urlCache[k]) { urls[k] = urlCache[k]; continue; }
          try {
            var res = await fetch(R2 + "/img/" + encodeURIComponent(k), { headers: { Authorization: "Bearer " + tk } });
            if (res.ok) {
              var b = await res.blob();
              urlCache[k] = URL.createObjectURL(b);
              urls[k] = urlCache[k];
            }
          } catch (e) { /* Bild bleibt leer */ }
        }
      }
    }

    bump({ p_reads: 1 });
    return rows.map(function (r) { return rowToEvent(r, byKey, urls); });
  }

  async function saveEvent(e) {
    var isNew = !e.id;
    var g = await guard(isNew ? "row" : "write");
    if (!g.ok) { var err = new Error(g.block.message); err.block = g.block; throw err; }

    var c = await client();
    var row = eventToRow(e);
    if (legacySchema) delete row.gwho;

    async function push(payload) {
      return isNew
        ? await c.from("events").insert(payload).select("id")
        : await c.from("events").update(payload).eq("id", e.id).select("id");
    }

    var r = await push(row);
    if (r.error && /perms/i.test(String(r.error.message || ""))) {
      var noPerms = Object.assign({}, row);
      delete noPerms.perms;
      r = await push(noPerms);
      if (!r.error) row = noPerms;
    }
    if (r.error && /gwho/i.test(String(r.error.message || ""))) {
      legacySchema = true;
      var flat = Object.assign({}, row);
      delete flat.gwho;
      if ((e.resolvedWho || []).length) flat.who = e.resolvedWho;
      r = await push(flat);
    }
    if (r.error) throw fail(code(r.error));
    bump({ p_writes: 1 });
    return (r.data && r.data[0] && r.data[0].id) || e.id;
  }

  async function removeEvent(id) {
    var g = await guard("write");
    if (!g.ok) { var err = new Error(g.block.message); err.block = g.block; throw err; }
    var c = await client();
    var r = await c.from("events").delete().eq("id", id);
    if (r.error) throw fail(code(r.error));
    bump({ p_writes: 1 });
  }

  async function addComment(eventId, imageIndex, text) {
    var g = await guard("write");
    if (!g.ok) { var err = new Error(g.block.message); err.block = g.block; throw err; }
    var c = await client();
    var r = await c.from("comments").insert({ event_id: eventId, image_index: imageIndex, text: text });
    if (r.error) throw fail(code(r.error));
    bump({ p_writes: 1 });
  }

  /* ---------------- Bilder ---------------- */

  /* Einzelnes Bild erneut besorgen (nach Neuladen oder wenn die Vorschau fehlt). */
  async function storeCheck() {
    if (!R2) return { ok: false, reason: "kein-worker" };
    try {
      var tk = await token();
      var res = await fetch(R2 + "/state", { headers: { Authorization: "Bearer " + tk } });
      var out = await res.json().catch(function () { return {}; });
      return { ok: !!res.ok && !!out.ok, status: res.status, detail: out };
    } catch (e) {
      return { ok: false, reason: "nicht-erreichbar", detail: String((e && e.message) || e) };
    }
  }

  async function imageUrl(keyOrPath) {
    var id = String(keyOrPath || "");
    if (!id) return "";
    if (urlCache[id]) return urlCache[id];
    if (R2) {
      try {
        var tk = await token();
        var res = await fetch(R2 + "/img/" + encodeURIComponent(id), { headers: { Authorization: "Bearer " + tk } });
        if (res.ok) { urlCache[id] = URL.createObjectURL(await res.blob()); return urlCache[id]; }
      } catch (e) { /* leer lassen */ }
    }
    /* Nur für Altbestand im Supabase-Speicher. */
    try {
      var c = await client();
      var sg = await c.storage.from(BUCKET).createSignedUrl(id, 60 * 60 * 12);
      return (sg.data && sg.data.signedUrl) || "";
    } catch (e) { return ""; }
  }

  async function uploadToR2(file) {
    var tk = await token();
    if (!tk) throw fail("D-09");
    var fd = new FormData();
    fd.append("file", file, file.name || "bild.jpg");
    fd.append("name", file.name || "bild.jpg");
    var res;
    try {
      res = await fetch(R2 + "/upload", { method: "POST", headers: { Authorization: "Bearer " + tk }, body: fd });
    } catch (netErr) {
      throw fail("D-06", netErr);
    }
    var out = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      if (out.error === "limit") {
        var eL = fail("D-13");
        eL.block = { scope: out.scope, message: out.message, again: "" };
        throw eL;
      }
      if (res.status === 401) throw fail("D-09", out);
      if (res.status === 403) throw fail("D-10", out);
      if (res.status === 404) throw fail("D-11", out);
      if (res.status === 413 || /gr\u00f6\u00dfer als|too large/i.test(String(out.message || ""))) throw fail("D-05", out);
      if (/keine Bilddatei|not an image/i.test(String(out.message || ""))) throw fail("D-08", out);
      if (res.status === 500 && /BUCKET|bucket/i.test(String(out.message || out.error || ""))) throw fail("D-12", out);
      throw fail("D-06", out);
    }
    var url = "";
    try {
      var r3 = await fetch(R2 + "/img/" + encodeURIComponent(out.key), { headers: { Authorization: "Bearer " + tk } });
      if (r3.ok) { url = URL.createObjectURL(await r3.blob()); urlCache[out.key] = url; }
    } catch (e) { /* Vorschau bleibt leer */ }
    bump({ p_uploads: 1, p_bytes: file.size || 0 });

    return { key: out.key, path: "", src: url };
  }

  async function uploadImage(file) {
    var g = await guard("upload", file.size);
    if (!g.ok) { var err = fail("D-13"); err.block = g.block; throw err; }

    if (!R2) throw fail("D-07");
    try {
      return await uploadToR2(file);
    } catch (e) {
      lastR2Error = code(e);
      throw e;
    }
  }

  /* ---------------- Live ---------------- */

  async function onChange(cb) {
    var c = await client();
    c.channel("chronik-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "events" }, cb)
      .on("postgres_changes", { event: "*", schema: "public", table: "comments" }, cb)
      .on("postgres_changes", { event: "*", schema: "public", table: "groups" }, cb)
      .on("postgres_changes", { event: "*", schema: "public", table: "contacts" }, cb)
      .subscribe();
  }

  window.ChronikCloud = {
    enabled: enabled,
    configFault: configFault,
    cleanedUrl: url,
    hasR2: !!R2, r2Only: true,
    turnstileKey: CFG.turnstileSiteKey || "",
    limits: LIM,
    signUp: signUp, signIn: signIn, signOut: signOut, session: session,
    sendReset: sendReset, updatePassword: updatePassword, recoveryPending: recoveryPending, onAuth: onAuth,
    sessionEmail: sessionEmail, notifyChange: notifyChange, linkAge: linkAge,
    emailTaken: emailTaken, nameTaken: nameTaken, emailForName: emailForName,
    profiles: profiles, setBlocked: setBlocked, history: history, undo: undo,
    groups: groups, saveGroup: saveGroup, removeGroup: removeGroup, saveLook: saveLook,
    saveNotify: saveNotify, notify: notify,
    friends: friends, askFriend: askFriend, answerFriend: answerFriend, unfriend: unfriend,
    loadEvents: loadEvents, saveEvent: saveEvent, removeEvent: removeEvent,
    addComment: addComment, removeComment: removeComment, uploadImage: uploadImage, imageUrl: imageUrl, storeCheck: storeCheck, onChange: onChange,
    snapshot: snapshot, budget: budget, guard: guard,
    isLegacy: function () { return legacySchema; },
    lastR2Error: function () { return lastR2Error; }
  };
})();
