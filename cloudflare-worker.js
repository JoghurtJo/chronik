/* ============================================================
   CHRONIK — Cloudflare Worker für die Bilder (R2)
   ============================================================
*/

const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-z._-]{1,80}$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/upload" && request.method === "POST") return await upload(request, env, cors);
      if (url.pathname === "/notify" && request.method === "POST") return await notify(request, env, cors);
      if (url.pathname.startsWith("/img/") && request.method === "GET") return await serve(request, env, url, cors);
      if (url.pathname === "/delete" && request.method === "POST") return await drop(request, env, cors);
      if (url.pathname === "/timetable" && request.method === "POST") return await timetable(request, env, cors);
      if (url.pathname === "/state") {
        let auth = "ok";
        try { await whoami(request, env); }
        catch (e) { auth = (e && e.code) || "D-06"; }
        return json({
          ok: true,
          auth: auth,
          bucket: !!env.BUCKET,
          ai: !!env.AI,
          supabase: baseUrl(env.SUPABASE_URL) || "leer",
          keyLen: String(env.SUPABASE_ANON_KEY || "").trim().length,
          origin: request.headers.get("Origin") || "",
          allowed: String(env.ALLOWED_ORIGIN || "*"),
          allowOrigin: cors["Access-Control-Allow-Origin"]
        }, 200, cors);
      }
      return json({ error: "D-11" }, 404, cors);
    } catch (e) {
      return json({ error: (e && e.code) || "D-06" }, (e && e.status) || 500, cors);
    }
  }
};

/* Nur der Ursprung zählt (Schema + Domain). Ein mitkopierter Pfad wie
   "https://name.github.io/chronik/" ist der häufigste Einrichtungsfehler —
   er wird hier abgeschnitten, damit der Browser die Antwort annimmt. */
function originOf(v) {
  const s = String(v || "").trim();
  if (!s || s === "*") return s;
  try { return new URL(s).origin; }
  catch (e) {
    const m = s.match(/^https?:\/\/[^/]+/i);
    return m ? m[0] : s.replace(/\/.*$/, "");
  }
}

/* Kurze Mail an eine andere Person — nur, wenn sie das eingestellt hat.
   Verschickt über die Brevo-Schnittstelle; der Schlüssel liegt als
   Worker-Variable BREVO_KEY, der Absender als BREVO_FROM. */
async function notify(request, env, cors) {
  const me = await whoami(request, env);
  if (!env.BREVO_KEY || !env.BREVO_FROM) return json({ error: "D-18" }, 501, cors);

  const body = await request.json().catch(() => ({}));
  const to = String(body.to || "");
  const kind = String(body.kind || "");
  if (!to || !kind) return json({ error: "D-19" }, 400, cors);

  const base = baseUrl(env.SUPABASE_URL);
  const key = String(env.SUPABASE_ANON_KEY || "").trim();
  const p = await fetch(base + "/rest/v1/profiles?id=eq." + encodeURIComponent(to) + "&select=email,notify,username", {
    headers: { apikey: key, Authorization: "Bearer " + me.token }
  });
  if (!p.ok) return json({ error: "D-19" }, 400, cors);
  const rows = await p.json().catch(() => []);
  const ziel = rows && rows[0];
  if (!ziel || !ziel.email) return json({ error: "D-19" }, 400, cors);
  /* Testmail nur an sich selbst. Alle anderen Mails nur, wenn die
     Person diese Art ausdrücklich angehakt hat — Standard ist aus. */
  if (kind === "test" && to !== me.id) return json({ error: "D-19" }, 400, cors);
  if (kind !== "test" && !(ziel.notify && ziel.notify[kind] === true)) return json({ ok: true, skipped: "abgewaehlt" }, 200, cors);

  const betreff = String(body.subject || "Chronik").slice(0, 120);
  const text = String(body.text || "").slice(0, 900);
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: "Chronik", email: env.BREVO_FROM },
      to: [{ email: ziel.email, name: ziel.username || "" }],
      subject: betreff,
      textContent: text
    })
  });
  if (!r.ok) {
    const grund = await r.text().catch(() => "");
    return json({ error: "D-20", detail: String(grund).slice(0, 200) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

function coded(c, status) {
  const e = new Error(c);
  e.code = c;
  e.status = status || 500;
  return e;
}

function corsHeaders(env, request) {
  const raw = String(env.ALLOWED_ORIGIN || "*").trim();
  const origin = request.headers.get("Origin") || "";
  const list = raw === "*" ? ["*"] : raw.split(",").map(originOf).filter(Boolean);
  const ok = list.indexOf("*") >= 0 || (origin && list.indexOf(originOf(origin)) >= 0);
  return {
    "Access-Control-Allow-Origin": ok ? (origin || "*") : (list[0] || "*"),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,content-type,x-chronik-name",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, cors)
  });
}

function baseUrl(v) {
  let s = String(v || "").trim().replace(/^["']|["']$/g, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  s = s.replace(/\/+$/, "").replace(/\/(auth|rest|storage|realtime)\/v1.*$/i, "").replace(/\/+$/, "");
  return s;
}

async function whoami(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw coded("D-09", 401);

  const base = baseUrl(env.SUPABASE_URL);
  const key = String(env.SUPABASE_ANON_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (!base || !key) throw coded("D-14", 500);

  let r;
  try {
    r = await fetch(base + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: key }
    });
  } catch (e) {
    throw coded("D-16", 502);
  }

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    if (/api ?key/i.test(body)) throw coded("D-17", 401);
    throw coded("D-09", 401);
  }
  const u = await r.json().catch(() => null);
  if (!u || !u.id) throw coded("D-09", 401);
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
  if (!file || typeof file === "string") return json({ error: "D-08" }, 400, cors);
  if (file.size > 25 * 1024 * 1024) return json({ error: "D-05" }, 413, cors);

  /* Handybilder kommen manchmal ohne Typangabe. Darum zählt auch die Endung. */
  const rawName = String(form.get("name") || file.name || "bild");
  const isImage = /^image\//i.test(file.type || "") ||
    /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i.test(rawName);
  if (!isImage) return json({ error: "D-08" }, 415, cors);

  if (!env.BUCKET) return json({ error: "D-12" }, 500, cors);

  const safe = rawName.toLowerCase().replace(/[^a-z0-9.]+/g, "-").slice(-60);
  const key = me.id + "/" + Date.now() + "-" + safe;
  if (!KEY_RE.test(key)) return json({ error: "D-08" }, 400, cors);

  await env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream", cacheControl: "private, max-age=3600" }
  });
  await bump(env, me.token, { p_uploads: 1, p_bytes: file.size });

  return json({ key: key, size: file.size }, 200, cors);
}

/* Bilder wegräumen, wenn ein Konto, Ereignis oder Bild verschwindet.
   Ohne das bleiben verwaiste Dateien im Speicher liegen. */
async function drop(request, env, cors) {
  const me = await whoami(request, env);
  if (!env.BUCKET) return json({ error: "D-12" }, 500, cors);
  let keys = [];
  try {
    const body = await request.json();
    keys = Array.isArray(body && body.keys) ? body.keys : [];
  } catch (e) { return json({ error: "D-08" }, 400, cors); }

  let weg = 0, bytes = 0;
  for (const k of keys.slice(0, 500)) {
    const key = String(k || "");
    if (!KEY_RE.test(key)) continue;
    try {
      const kopf = await env.BUCKET.head(key);
      if (kopf && kopf.size) bytes += kopf.size;
      await env.BUCKET.delete(key);
      weg++;
    } catch (e) { /* schon weg */ }
  }
  if (bytes > 0) {
    try { await bump(env, me.token, { p_bytes: -bytes, p_uploads: 0 }); } catch (e) { /* Zähler bleibt */ }
  }
  return json({ ok: true, deleted: weg, bytes: bytes }, 200, cors);
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
  if (!KEY_RE.test(key)) return json({ error: "D-08" }, 400, cors);

  const obj = await env.BUCKET.get(key);
  if (!obj) return json({ error: "D-04" }, 404, cors);

  await bump(env, me.token, { p_gets: 1, p_bytes_out: Number(obj.size || 0) });

  const h = new Headers(cors);
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  h.set("cache-control", "private, max-age=3600");
  return new Response(obj.body, { headers: h });
}


/* Timetable lesen — mit Workers AI */
const TT_PROMPT = "Read the festival or event timetable in this image. Return ONLY valid JSON, no explanation, no markdown, exactly in this form: " +
  "{\"tage\":[{\"label\":\"day as printed, e.g. Friday 12.07.\",\"acts\":[{\"name\":\"act or band\",\"buehne\":\"stage name or empty\",\"von\":\"HH:MM\",\"bis\":\"HH:MM or empty\"}]}]}. " +
  "Use 24-hour times. If the timetable is a grid, read start and end of each act from its position against the time axis and its stage from the row or column header. " +
  "If no day is printed, use one entry with an empty label. Include every act exactly once and do not invent anything.";

function ttText(out) {
  if (out == null) return "";
  if (typeof out === "string") return out;
  let r = out.response !== undefined ? out.response : (out.result && out.result.response !== undefined ? out.result.response : undefined);
  if (r === undefined && out.choices && out.choices[0]) r = (out.choices[0].message || {}).content;
  if (r === undefined) r = out;
  return typeof r === "string" ? r : JSON.stringify(r);
}

function ttJson(text) {
  const t = String(text || "").replace(/```(json)?/gi, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { const d = JSON.parse(t.slice(a, b + 1)); return d && Array.isArray(d.tage) ? d : (d && Array.isArray(d.acts) ? { tage: [{ label: "", acts: d.acts }] } : null); } catch (e) { return null; }
}

async function timetable(request, env, cors) {
  await whoami(request, env);
  if (!env.AI) return json({ error: "D-20" }, 501, cors);
  const body = await request.json().catch(() => ({}));
  const bild = String(body.bild || "");
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(bild) || bild.length > 6000000) return json({ error: "D-08" }, 400, cors);
  const modelle = [env.TT_MODEL, "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/google/gemma-3-12b-it", "@cf/meta/llama-3.2-11b-vision-instruct"].filter(Boolean);
  const fehler = [];
  let bytes = null;
  for (const m of modelle) {
    try {
      let out;
      if (/llama-3\.2/.test(m)) {
        if (!bytes) { const roh = atob(bild.split(",")[1]); bytes = new Array(roh.length); for (let i = 0; i < roh.length; i++) bytes[i] = roh.charCodeAt(i); }
        const run = () => env.AI.run(m, { prompt: TT_PROMPT, image: bytes, max_tokens: 4096 });
        try { out = await run(); }
        catch (e) {
          if (/agree|licen/i.test(String((e && e.message) || ""))) { await env.AI.run(m, { prompt: "agree" }); out = await run(); } else throw e;
        }
      } else {
        out = await env.AI.run(m, {
          messages: [
            { role: "system", content: "You extract timetables from images and answer with JSON only." },
            { role: "user", content: [{ type: "text", text: TT_PROMPT }, { type: "image_url", image_url: { url: bild } }] }
          ],
          max_tokens: 4096, temperature: 0.1
        });
      }
      const d = ttJson(ttText(out));
      if (d) return json({ ok: true, tage: d.tage, modell: m.split("/").pop() }, 200, cors);
      fehler.push(m.split("/").pop() + ": " + ttText(out).slice(0, 80));
    } catch (e) { fehler.push(m.split("/").pop() + ": " + String((e && e.message) || e).slice(0, 120)); }
  }
  return json({ error: "D-21", detail: fehler.join(" | ").slice(0, 600) }, 502, cors);
}
