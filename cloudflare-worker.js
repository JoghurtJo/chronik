/* ============================================================
   CHRONIK — Cloudflare Worker für die Bilder (R2)
   ============================================================
   Aufgabe: Bilder annehmen und ausliefern, aber nur für
   angemeldete Personen — und nur solange die Gratis-Grenzen
   nicht erreicht sind.

   Der Worker ist die Tür zum Bildspeicher. Ohne ihn müsste der
   R2-Schlüssel in der Webseite stehen, und den könnte jeder lesen.

   Einrichten (steht ausführlich in der Anleitung):
     1. Cloudflare → R2 → Bucket "chronik-bilder" anlegen
     2. Workers & Pages → Create Worker → diesen Code einfügen
     3. Settings → Bindings → R2 bucket:  Variable BUCKET  →  chronik-bilder
     4. Settings → Variables:
          SUPABASE_URL      = https://xxxx.supabase.co
          SUPABASE_ANON_KEY = eyJ… (anon public)
          ALLOWED_ORIGIN    = https://deinname.github.io
          MAX_BYTES         = 8000000000     (8 GB von 10 GB)
          MAX_UPLOADS_DAY   = 2000
          MAX_GETS_DAY      = 60000
     5. Adresse des Workers in chronik-config.js als r2Worker eintragen
   ============================================================ */

const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-z._-]{1,80}$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/upload" && request.method === "POST") return await upload(request, env, cors);
      if (url.pathname.startsWith("/img/") && request.method === "GET") return await serve(request, env, url, cors);
      if (url.pathname === "/state") return json({ ok: true }, 200, cors);
      return json({ error: "Unbekannter Aufruf." }, 404, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, cors);
    }
  }
};

function corsHeaders(env, request) {
  const allow = env.ALLOWED_ORIGIN || "*";
  const origin = request.headers.get("Origin") || "";
  const ok = allow === "*" || allow.split(",").some((a) => origin.startsWith(a.trim()));
  return {
    "Access-Control-Allow-Origin": ok ? (origin || allow) : allow.split(",")[0].trim(),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,content-type,x-chronik-name",
    "Access-Control-Max-Age": "86400"
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, cors)
  });
}

/* Wer ist das? Der Worker fragt Supabase, ob das Anmelde-Ticket gilt. */
async function whoami(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("Nicht angemeldet.");
  const r = await fetch(env.SUPABASE_URL + "/auth/v1/user", {
    headers: { Authorization: "Bearer " + token, apikey: env.SUPABASE_ANON_KEY }
  });
  if (!r.ok) throw new Error("Anmeldung abgelaufen — bitte neu anmelden.");
  const u = await r.json();
  if (!u || !u.id) throw new Error("Anmeldung abgelaufen — bitte neu anmelden.");
  return { id: u.id, token: token };
}

/* Zähler und Grenzen — der Worker fragt die Chronik-Datenbank. */
async function usage(env, token) {
  const r = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/usage_snapshot", {
    method: "POST",
    headers: { "content-type": "application/json", apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
    body: "{}"
  });
  if (!r.ok) return null;
  return await r.json();
}

async function bump(env, token, patch) {
  await fetch(env.SUPABASE_URL + "/rest/v1/rpc/bump_usage", {
    method: "POST",
    headers: { "content-type": "application/json", apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
    body: JSON.stringify(patch)
  });
}

function num(v, dflt) { const n = Number(v); return isFinite(n) && n > 0 ? n : dflt; }

async function upload(request, env, cors) {
  const me = await whoami(request, env);
  const u = await usage(env, me.token);
  const maxBytes = num(env.MAX_BYTES, 8000000000);
  const maxUp = num(env.MAX_UPLOADS_DAY, 2000);

  if (u) {
    const bytes = Number(u.bytes || 0);
    const upsToday = Number((u.day && u.day.uploads) || 0);
    if (bytes >= maxBytes) {
      return json({ error: "limit", scope: "speicher",
        message: "Der Fotospeicher ist voll. Es passen keine neuen Bilder mehr hinein, bis ältere gelöscht werden.",
        used: bytes, cap: maxBytes }, 429, cors);
    }
    if (upsToday >= maxUp) {
      return json({ error: "limit", scope: "uploads-heute",
        message: "Für heute sind genug Bilder hochgeladen. Morgen geht es weiter.",
        used: upsToday, cap: maxUp }, 429, cors);
    }
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") throw new Error("Keine Datei dabei.");
  if (file.size > 12 * 1024 * 1024) throw new Error("Dieses Bild ist größer als 12 MB — bitte vorher verkleinern.");
  if (!/^image\//.test(file.type || "")) throw new Error("Das ist keine Bilddatei.");

  const safe = String(form.get("name") || file.name || "bild")
    .toLowerCase().replace(/[^a-z0-9.]+/g, "-").slice(-60);
  const key = me.id + "/" + Date.now() + "-" + safe;
  if (!KEY_RE.test(key)) throw new Error("Ungültiger Dateiname.");

  await env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type, cacheControl: "private, max-age=3600" }
  });
  await bump(env, me.token, { p_uploads: 1, p_bytes: file.size });

  return json({ key: key, size: file.size }, 200, cors);
}

async function serve(request, env, url, cors) {
  const me = await whoami(request, env);
  const u = await usage(env, me.token);
  const maxGets = num(env.MAX_GETS_DAY, 60000);
  if (u && Number((u.day && u.day.gets) || 0) >= maxGets) {
    return json({ error: "limit", scope: "abrufe-heute",
      message: "Für heute sind sehr viele Bilder abgerufen worden. Morgen ist wieder alles da." }, 429, cors);
  }

  const key = decodeURIComponent(url.pathname.replace(/^\/img\//, ""));
  if (!KEY_RE.test(key)) return json({ error: "Ungültiger Bildname." }, 400, cors);

  const obj = await env.BUCKET.get(key);
  if (!obj) return json({ error: "Dieses Bild gibt es nicht mehr." }, 404, cors);

  await bump(env, me.token, { p_gets: 1, p_bytes_out: Number(obj.size || 0) });

  const h = new Headers(cors);
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  h.set("cache-control", "private, max-age=3600");
  return new Response(obj.body, { headers: h });
}
