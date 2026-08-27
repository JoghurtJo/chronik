/* Chronik ↔ Supabase (Konten, Ereignisse) + Cloudflare R2 (Bilder).
   Stellt window.ChronikCloud bereit. Kein Build, kein npm.
   Jede Aktion wird vorher gegen die Gratis-Grenzen geprüft. */
(function () {
  var CFG = window.CHRONIK_CONFIG || {};
  var SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js";
  var BUCKET = "bilder";

  /* Adresse geradeziehen: Leerzeichen, Schrägstriche und mitkopierte
     Pfade wie /rest/v1 sind der häufigste Einrichtungsfehler. */
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

  /* Was ist faul? Klartext für die Anmeldeseite. */
  var configFault = "";
  if (rawUrl || rawKey) {
    if (!rawUrl) configFault = "In chronik-config.js fehlt die Adresse (url). Sie steht in Supabase unter Project Settings → API als ‚Project URL‘.";
    else if (!URL_OK.test(url)) configFault = "Die Adresse in chronik-config.js sieht nicht wie eine Supabase-Adresse aus. Erwartet wird genau ‚https://xxxx.supabase.co‘ — ohne Schrägstrich und ohne Zusatz am Ende. Eingetragen ist: " + rawUrl;
    else if (!rawKey) configFault = "In chronik-config.js fehlt der Schlüssel (anonKey) — in Supabase unter Project Settings → API als ‚anon public‘.";
    else if (!KEY_OK.test(rawKey)) configFault = "Der Schlüssel in chronik-config.js ist unvollständig. Er ist sehr lang, beginnt mit ‚ey‘ und enthält zwei Punkte — bitte in Supabase noch einmal ganz kopieren.";
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

  function loadSdk() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = SDK;
      s.onload = res;
      s.onerror = function () { rej(new Error("Die Verbindungs-Bibliothek konnte nicht geladen werden. Internetverbindung prüfen.")); };
      document.head.appendChild(s);
    });
    return loading;
  }

  async function client() {
    if (!enabled) throw new Error(configFault || "Keine Zugangsdaten in chronik-config.js.");
    if (sb) return sb;
    await loadSdk();
    sb = window.supabase.createClient(url, rawKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return sb;
  }

  function msg(e) {
    var t = String((e && e.message) || e || "");
    if (/Invalid login credentials/i.test(t)) return "E-Mail oder Passwort stimmt nicht.";
    if (/Email not confirmed/i.test(t)) return "Bitte zuerst den Link in der Bestätigungsmail anklicken.";
    if (/User already registered|already been registered/i.test(t)) return "Für diese E-Mail gibt es schon ein Konto.";
    if (/captcha/i.test(t)) return "Die Sicherheitsprüfung ist nicht durchgekommen. Bitte nochmal versuchen.";
    if (/rate limit|too many|Email rate/i.test(t)) return "Zu viele Versuche in kurzer Zeit. Bitte in einer Stunde nochmal — so schützt der Dienst vor Massenanmeldungen.";
    if (/row-level security|violates row-level/i.test(t)) return "Dafür fehlt die Berechtigung. Wenn du gesperrt wurdest, wende dich an die Inhaberin oder den Inhaber.";
    if (/duplicate key|profiles_username/i.test(t)) return "Dieser Benutzername ist schon belegt.";
    if (/Password should be at least/i.test(t)) return "Das Passwort ist zu kurz.";
    if (/schema cache|column .* does not exist|Could not find the/i.test(t)) return "Die Datenbank ist noch nicht auf dem neuesten Stand. Bitte supabase-setup.sql einmal im SQL Editor ausführen (Anleitung, Schritt A4) — danach geht es.";
    if (/Error sending confirmation email|error sending.*email|smtp/i.test(t)) return "Das Konto wurde nicht angelegt, weil die Bestätigungsmail nicht rausging. Der Mailversand (Brevo) muss die Absende-Adresse von Supabase erst freigeben — siehe Anleitung, Schritt A15. Danach einfach nochmal versuchen.";
    if (/invalid path|no Route matched|not found/i.test(t)) return "Die Adresse der Datenbank stimmt nicht. In chronik-config.js muss bei url genau ‚https://xxxx.supabase.co‘ stehen — ohne Schrägstrich und ohne Zusatz wie /rest/v1 am Ende.";
    if (/Invalid API key|JWSError|JWT/i.test(t)) return "Der Schlüssel in chronik-config.js passt nicht. Es muss der ‚anon public‘-Schlüssel sein — bitte in Supabase noch einmal ganz kopieren.";
    if (/Failed to fetch|NetworkError|Load failed/i.test(t)) return "Die Datenbank ist nicht erreichbar. Internetverbindung prüfen — oder das Supabase-Projekt pausiert (im Dashboard auf ‚Restore‘).";
    return t || "Unbekannter Fehler.";
  }

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
    if (await emailTaken(email)) throw new Error("Für diese E-Mail gibt es schon ein Konto. Melde dich an oder setze das Passwort neu.");
    if (await nameTaken(username)) throw new Error("Dieser Benutzername ist schon belegt — bitte einen anderen wählen.");
    var opts = { data: { username: username }, emailRedirectTo: backHere() };
    if (captchaToken) opts.captchaToken = captchaToken;
    var r = await c.auth.signUp({ email: email, password: pw, options: opts });
    if (r.error) throw new Error(msg(r.error));
    bump({ p_emails: 1 });
    return { session: r.data.session, needsConfirm: !r.data.session };
  }

  async function signIn(email, pw, captchaToken) {
    var c = await client();
    var opts = captchaToken ? { captchaToken: captchaToken } : undefined;
    var r = await c.auth.signInWithPassword({ email: email, password: pw, options: opts });
    if (r.error) throw new Error(msg(r.error));
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
    return s ? s.access_token : "";
  }

  /* Genau diese Seite — mit Dateinamen, damit der Link aus der Mail
     nicht auf einer 404-Seite von GitHub Pages landet. */
  function backHere() {
    var u = location.origin + location.pathname;
    if (/\/$/.test(u)) u = u + "index.html";
    return u;
  }

  async function sendReset(email) {
    var c = await client();
    var r = await c.auth.resetPasswordForEmail(email, { redirectTo: backHere() });
    if (r.error) throw new Error(msg(r.error));
    bump({ p_emails: 1 });
    return true;
  }

  async function updatePassword(pw) {
    var c = await client();
    var r = await c.auth.updateUser({ password: pw });
    if (r.error) throw new Error(msg(r.error));
    return true;
  }

  function recoveryPending() { return /type=recovery/.test(location.hash || ""); }

  async function onAuth(cb) {
    var c = await client();
    c.auth.onAuthStateChange(function (evt, s) { cb(evt, s); });
  }

  async function profiles() {
    var c = await client();
    var r = await c.from("profiles").select("id, username, email, role, blocked, look").order("username");
    /* Ältere Datenbank ohne look-Spalte: ohne sie nochmal fragen. */
    if (r.error && /look/i.test(String(r.error.message || ""))) {
      r = await c.from("profiles").select("id, username, email, role, blocked").order("username");
    }
    if (r.error) throw new Error(msg(r.error));
    return (r.data || []).map(function (p) {
      return {
        id: p.id, username: p.username || (p.email || "").split("@")[0],
        email: p.email || "", role: p.role || "member", blocked: !!p.blocked,
        look: p.look || {}
      };
    });
  }

  async function setBlocked(userId, blocked) {
    var c = await client();
    var r = await c.rpc("set_blocked", { p_user: userId, p_blocked: !!blocked });
    if (r.error) throw new Error(msg(r.error));
  }

  /* ---------------- Verlauf ---------------- */

  /* ---------- Kontakte ---------- */

  async function friends() {
    var c = await client();
    var r = await c.from("contacts").select("id, asker, askee, status");
    if (r.error) throw new Error(msg(r.error));
    return (r.data || []).map(function (x) {
      return { id: x.id, from: x.asker, to: x.askee, status: x.status || "pending" };
    });
  }

  async function askFriend(otherId) {
    var c = await client();
    var r = await c.from("contacts").insert({ askee: otherId }).select("id");
    if (r.error) throw new Error(msg(r.error));
    bump({ p_writes: 1 });
    return (r.data && r.data[0] && r.data[0].id) || null;
  }

  async function answerFriend(id, accept) {
    var c = await client();
    var r = accept
      ? await c.from("contacts").update({ status: "accepted" }).eq("id", id)
      : await c.from("contacts").delete().eq("id", id);
    if (r.error) throw new Error(msg(r.error));
    bump({ p_writes: 1 });
  }

  async function unfriend(id) {
    var c = await client();
    var r = await c.from("contacts").delete().eq("id", id);
    if (r.error) throw new Error(msg(r.error));
    bump({ p_writes: 1 });
  }

  /* Aussehen und Titel gehören zur Person und reisen mit aufs nächste Gerät. */
  async function saveLook(look) {
    var c = await client();
    var s = await c.auth.getUser();
    var id = s && s.data && s.data.user && s.data.user.id;
    if (!id) return;
    var r = await c.from("profiles").update({ look: look || {} }).eq("id", id);
    if (r.error && !/look/i.test(String(r.error.message || ""))) throw new Error(msg(r.error));
  }

  async function groups() {
    var c = await client();
    var r = await c.from("groups").select("id, name, members").order("name");
    if (r.error) throw new Error(msg(r.error));
    return (r.data || []).map(function (g) { return { id: g.id, name: g.name || "", members: g.members || [] }; });
  }

  async function saveGroup(g) {
    var c = await client();
    var row = { name: g.name || "", members: g.members || [] };
    var r = g.id && String(g.id).length > 20
      ? await c.from("groups").update(row).eq("id", g.id).select("id")
      : await c.from("groups").insert(row).select("id");
    if (r.error) throw new Error(msg(r.error));
    bump({ p_writes: 1 });
    return (r.data && r.data[0] && r.data[0].id) || g.id;
  }

  async function removeGroup(id) {
    var c = await client();
    var r = await c.from("groups").delete().eq("id", id);
    if (r.error) throw new Error(msg(r.error));
    bump({ p_writes: 1 });
  }

  async function history(limit) {
    var c = await client();
    var r = await c.from("event_history")
      .select("id, event_id, action, actor, at, undone, snapshot")
      .order("at", { ascending: false }).limit(limit || 40);
    if (r.error) throw new Error(msg(r.error));
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
    if (r.error) throw new Error(msg(r.error));
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
    if (ev.error) throw new Error(msg(ev.error));
    var rows = ev.data || [];

    var cm = await c.from("comments").select("event_id, image_index, text, created_at, profiles(username)").order("created_at");
    var byKey = {};
    (cm.data || []).forEach(function (r) {
      var k = r.event_id + ":" + (r.image_index || 0);
      (byKey[k] = byKey[k] || []).push({ who: (r.profiles && r.profiles.username) || "jemand", text: r.text });
    });

    /* Bild-Adressen besorgen: R2 über den Worker, sonst Supabase-Speicher */
    var urls = {};
    var r2keys = [], spaths = [];
    rows.forEach(function (r) {
      ((r.data || {}).images || []).forEach(function (im) {
        if (im.key) r2keys.push(im.key); else if (im.path) spaths.push(im.path);
      });
    });
    if (spaths.length) {
      var sg = await c.storage.from(BUCKET).createSignedUrls(spaths, 60 * 60 * 12);
      (sg.data || []).forEach(function (s) { if (s.path && s.signedUrl) urls[s.path] = s.signedUrl; });
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
    /* Ältere Datenbank ohne Gruppen-Spalte: Gruppen zu Personen
       auflösen und ohne gwho erneut senden. */
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
    if (r.error) throw new Error(msg(r.error));
    bump({ p_writes: 1 });
    return (r.data && r.data[0] && r.data[0].id) || e.id;
  }

  async function removeEvent(id) {
    var g = await guard("write");
    if (!g.ok) { var err = new Error(g.block.message); err.block = g.block; throw err; }
    var c = await client();
    var r = await c.from("events").delete().eq("id", id);
    if (r.error) throw new Error(msg(r.error));
    bump({ p_writes: 1 });
  }

  async function addComment(eventId, imageIndex, text) {
    var g = await guard("write");
    if (!g.ok) { var err = new Error(g.block.message); err.block = g.block; throw err; }
    var c = await client();
    var r = await c.from("comments").insert({ event_id: eventId, image_index: imageIndex, text: text });
    if (r.error) throw new Error(msg(r.error));
    bump({ p_writes: 1 });
  }

  /* ---------------- Bilder ---------------- */

  /* Einzelnes Bild erneut besorgen (nach Neuladen oder wenn die Vorschau fehlt). */
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
    try {
      var c = await client();
      var sg = await c.storage.from(BUCKET).createSignedUrl(id, 60 * 60 * 12);
      return (sg.data && sg.data.signedUrl) || "";
    } catch (e) { return ""; }
  }

  async function uploadImage(file) {
    var g = await guard("upload", file.size);
    if (!g.ok) { var err = new Error(g.block.message); err.block = g.block; throw err; }

    if (R2) {
      var tk = await token();
      var fd = new FormData();
      fd.append("file", file);
      fd.append("name", file.name || "bild");
      var res = await fetch(R2 + "/upload", { method: "POST", headers: { Authorization: "Bearer " + tk }, body: fd });
      var out = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        var e2 = new Error(out.message || out.error || "Das Bild konnte nicht hochgeladen werden.");
        if (out.error === "limit") e2.block = { scope: out.scope, message: out.message, again: "" };
        throw e2;
      }
      var url = "";
      try {
        var r3 = await fetch(R2 + "/img/" + encodeURIComponent(out.key), { headers: { Authorization: "Bearer " + tk } });
        if (r3.ok) { url = URL.createObjectURL(await r3.blob()); urlCache[out.key] = url; }
      } catch (e) { /* Vorschau bleibt leer */ }
      bump({ p_uploads: 1, p_bytes: file.size || 0 });
      return { key: out.key, path: "", src: url };
    }

    var c = await client();
    var s = await c.auth.getUser();
    var uid = (s.data && s.data.user && s.data.user.id) || "anon";
    var clean = String(file.name || "bild").toLowerCase().replace(/[^a-z0-9.]+/g, "-").slice(-40);
    var path = uid + "/" + Date.now() + "-" + clean;
    var up = await c.storage.from(BUCKET).upload(path, file, { cacheControl: "3600", upsert: false });
    if (up.error) throw new Error(msg(up.error));
    var sg = await c.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 12);
    bump({ p_uploads: 1, p_bytes: file.size });
    return { path: path, src: (sg.data && sg.data.signedUrl) || "" };
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
    hasR2: !!R2,
    turnstileKey: CFG.turnstileSiteKey || "",
    limits: LIM,
    signUp: signUp, signIn: signIn, signOut: signOut, session: session,
    sendReset: sendReset, updatePassword: updatePassword, recoveryPending: recoveryPending, onAuth: onAuth,
    emailTaken: emailTaken, nameTaken: nameTaken,
    profiles: profiles, setBlocked: setBlocked, history: history, undo: undo,
    groups: groups, saveGroup: saveGroup, removeGroup: removeGroup, saveLook: saveLook,
    friends: friends, askFriend: askFriend, answerFriend: answerFriend, unfriend: unfriend,
    loadEvents: loadEvents, saveEvent: saveEvent, removeEvent: removeEvent,
    addComment: addComment, uploadImage: uploadImage, imageUrl: imageUrl, onChange: onChange,
    snapshot: snapshot, budget: budget, guard: guard,
    isLegacy: function () { return legacySchema; }
  };
})();
