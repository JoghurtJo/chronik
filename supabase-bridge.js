/* Chronik ↔ Supabase (Konten, Ereignisse) + Cloudflare R2 (Bilder).
   Stellt window.ChronikCloud bereit. Kein Build, kein npm.
   Jede Aktion wird vorher gegen die Gratis-Grenzen geprüft. */
(function () {
  var CFG = window.CHRONIK_CONFIG || {};
  var SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js";
  var BUCKET = "bilder";
  var enabled = !!(CFG.url && CFG.anonKey);
  var R2 = String(CFG.r2Worker || "").replace(/\/+$/, "");
  var LIM = Object.assign({
    dbRows: 4000, writesPerDay: 1500, readsPerDay: 8000, uploadsPerDay: 300,
    getsPerDay: 50000, storageBytes: 8000000000, egressPerMonth: 4000000000, emailsPerHour: 3
  }, CFG.limits || {});
  var sb = null, loading = null, snap = null, snapAt = 0;
  var urlCache = {};

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
    if (!enabled) throw new Error("Keine Zugangsdaten in chronik-config.js.");
    if (sb) return sb;
    await loadSdk();
    sb = window.supabase.createClient(CFG.url, CFG.anonKey, {
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

  async function signUp(email, pw, username, captchaToken) {
    var c = await client();
    if (await emailTaken(email)) throw new Error("Für diese E-Mail gibt es schon ein Konto. Melde dich an oder setze das Passwort neu.");
    var opts = { data: { username: username } };
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

  async function sendReset(email) {
    var c = await client();
    var r = await c.auth.resetPasswordForEmail(email, { redirectTo: location.href.split("#")[0] });
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
    var r = await c.from("profiles").select("id, username, email, role, blocked").order("username");
    if (r.error) throw new Error(msg(r.error));
    return (r.data || []).map(function (p) {
      return {
        id: p.id, username: p.username || (p.email || "").split("@")[0],
        email: p.email || "", role: p.role || "member", blocked: !!p.blocked
      };
    });
  }

  async function setBlocked(userId, blocked) {
    var c = await client();
    var r = await c.rpc("set_blocked", { p_user: userId, p_blocked: !!blocked });
    if (r.error) throw new Error(msg(r.error));
  }

  /* ---------------- Verlauf ---------------- */

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
      vis: row.vis || "public", who: row.who || [], share: row.share || "view",
      changedBy: row.changed_by || ""
    };
  }

  function eventToRow(e) {
    return {
      name: e.name || "", date: e.date || null, end_date: e.end || null,
      place: e.place || "", kicker: e.kicker || "",
      vis: e.vis || "public", who: e.who || [], share: e.share || "view",
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
    var r = isNew
      ? await c.from("events").insert(row).select("id")
      : await c.from("events").update(row).eq("id", e.id).select("id");
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
      return { key: out.key, src: url };
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
      .subscribe();
  }

  window.ChronikCloud = {
    enabled: enabled,
    hasR2: !!R2,
    turnstileKey: CFG.turnstileSiteKey || "",
    limits: LIM,
    signUp: signUp, signIn: signIn, signOut: signOut, session: session,
    sendReset: sendReset, updatePassword: updatePassword, recoveryPending: recoveryPending, onAuth: onAuth,
    emailTaken: emailTaken,
    profiles: profiles, setBlocked: setBlocked, history: history, undo: undo,
    loadEvents: loadEvents, saveEvent: saveEvent, removeEvent: removeEvent,
    addComment: addComment, uploadImage: uploadImage, onChange: onChange,
    snapshot: snapshot, budget: budget, guard: guard
  };
})();
