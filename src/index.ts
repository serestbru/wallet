type PassKey = { passTypeIdentifier: string; serialNumber: string };
type PassRow = PassKey & { authentication_token: string; updated_at: string; pkpass: ArrayBuffer | null };

const textEncoder = new TextEncoder();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function appleToken(request: Request): string | null {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("ApplePass ") ? value.slice("ApplePass ".length) : null;
}

function passKey(passTypeIdentifier: string, serialNumber: string): PassKey {
  return { passTypeIdentifier: decodeURIComponent(passTypeIdentifier), serialNumber: decodeURIComponent(serialNumber) };
}

function adminAuthorized(request: Request, env: Env): boolean {
  const configured = env.ADMIN_API_KEY;
  if (!configured) return false;
  const bearer = request.headers.get("authorization") ?? "";
  const supplied = bearer.startsWith("Bearer ")
    ? bearer.slice("Bearer ".length)
    : request.headers.get("x-admin-api-key");
  return supplied === configured;
}

async function getPass(env: Env, key: PassKey): Promise<PassRow | null> {
  return env.DB.prepare(
    `SELECT pass_type_identifier, serial_number, authentication_token, updated_at, pkpass
     FROM passes WHERE pass_type_identifier = ? AND serial_number = ?`
  ).bind(key.passTypeIdentifier, key.serialNumber).first<PassRow>();
}

async function authenticatePass(request: Request, env: Env, key: PassKey): Promise<boolean> {
  const token = appleToken(request);
  if (!token) return false;
  const pass = await getPass(env, key);
  if (pass) return token === pass.authentication_token;
  return Boolean(env.APPLE_PASS_AUTH_TOKEN && token === env.APPLE_PASS_AUTH_TOKEN);
}

async function ensurePass(env: Env, key: PassKey, token: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO passes(pass_type_identifier, serial_number, authentication_token)
     VALUES (?, ?, ?)
     ON CONFLICT(pass_type_identifier, serial_number) DO NOTHING`
  ).bind(key.passTypeIdentifier, key.serialNumber, token).run();
}

async function touchPass(env: Env, key: PassKey): Promise<void> {
  await env.DB.prepare(
    `UPDATE passes
     SET updated_at = CAST(MAX(CAST(updated_at AS INTEGER) + 1, CAST(strftime('%s', 'now') AS INTEGER)) AS TEXT)
     WHERE pass_type_identifier = ? AND serial_number = ?`
  ).bind(key.passTypeIdentifier, key.serialNumber).run();
}

async function register(request: Request, env: Env, key: PassKey, deviceId: string): Promise<Response> {
  if (!(await authenticatePass(request, env, key))) return json({ error: "unauthorized" }, 401);
  const body = await request.json().catch(() => null) as { pushToken?: string } | null;
  if (!body?.pushToken) return json({ error: "pushToken is required" }, 400);

  await ensurePass(env, key, appleToken(request)!);
  await env.DB.prepare(
    `INSERT INTO devices(device_library_identifier, push_token)
     VALUES (?, ?)
     ON CONFLICT(device_library_identifier)
     DO UPDATE SET push_token = excluded.push_token, updated_at = strftime('%s', 'now')`
  ).bind(deviceId, body.pushToken).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO registrations(device_library_identifier, pass_type_identifier, serial_number)
     VALUES (?, ?, ?)`
  ).bind(deviceId, key.passTypeIdentifier, key.serialNumber).run();
  return new Response(null, { status: 201 });
}

async function unregister(request: Request, env: Env, key: PassKey, deviceId: string): Promise<Response> {
  if (!(await authenticatePass(request, env, key))) return json({ error: "unauthorized" }, 401);
  await env.DB.prepare(
    `DELETE FROM registrations WHERE device_library_identifier = ? AND pass_type_identifier = ? AND serial_number = ?`
  ).bind(deviceId, key.passTypeIdentifier, key.serialNumber).run();
  await env.DB.prepare(
    `DELETE FROM devices WHERE device_library_identifier = ?
     AND NOT EXISTS (SELECT 1 FROM registrations WHERE device_library_identifier = ?)`
  ).bind(deviceId, deviceId).run();
  return new Response(null, { status: 200 });
}

async function changedPasses(request: Request, env: Env, deviceId: string, passTypeIdentifier: string): Promise<Response> {
  const device = await env.DB.prepare(
    `SELECT device_library_identifier FROM devices WHERE device_library_identifier = ?`
  ).bind(deviceId).first();
  if (!device) return json({ error: "unauthorized" }, 401);

  const rawPrevious = new URL(request.url).searchParams.get("passesUpdatedSince");
  const previous = rawPrevious ? Number(rawPrevious) : 0;
  if (!Number.isFinite(previous) || previous < 0) return json({ error: "invalid passesUpdatedSince" }, 400);
  const rows = await env.DB.prepare(
    `SELECT r.serial_number
     FROM registrations r JOIN passes p
     ON p.pass_type_identifier = r.pass_type_identifier AND p.serial_number = r.serial_number
     WHERE r.device_library_identifier = ?
       AND r.pass_type_identifier = ?
       AND CAST(p.updated_at AS INTEGER) > ?`
  ).bind(deviceId, passTypeIdentifier, previous).all<{ serial_number: string }>();
  const latest = await env.DB.prepare(
    `SELECT COALESCE(MAX(CAST(p.updated_at AS INTEGER)), ?) AS last_updated
     FROM registrations r JOIN passes p
     ON p.pass_type_identifier = r.pass_type_identifier AND p.serial_number = r.serial_number
     WHERE r.device_library_identifier = ? AND r.pass_type_identifier = ?`
  ).bind(previous, deviceId, passTypeIdentifier).first<{ last_updated: number }>();
  return json({
    serialNumbers: rows.results.map((row) => row.serial_number),
    lastUpdated: String(latest?.last_updated ?? previous)
  });
}

async function downloadPass(request: Request, env: Env, key: PassKey): Promise<Response> {
  if (!(await authenticatePass(request, env, key))) return json({ error: "unauthorized" }, 401);
  const pass = await getPass(env, key);
  if (!pass) return json({ error: "pass_not_found" }, 404);
  if (!pass.pkpass) return json({ error: "pkpass_not_uploaded" }, 503);

  const clientTag = request.headers.get("if-modified-since");
  if (clientTag && Number.isFinite(Number(clientTag)) && Number(clientTag) >= Number(pass.updated_at)) {
    return new Response(null, { status: 304 });
  }
  return new Response(pass.pkpass, {
    headers: {
      "content-type": "application/vnd.apple.pkpass",
      "cache-control": "no-cache",
      "last-modified": pass.updated_at
    }
  });
}

async function installPass(request: Request, env: Env, key: PassKey): Promise<Response> {
  const pass = await getPass(env, key);
  const token = new URL(request.url).searchParams.get("token");
  if (!pass || !token || token !== pass.authentication_token) return json({ error: "unauthorized" }, 401);
  if (!pass.pkpass) return json({ error: "pkpass_not_uploaded" }, 503);
  return new Response(pass.pkpass, {
    headers: {
      "content-type": "application/vnd.apple.pkpass",
      "content-disposition": `attachment; filename="${key.serialNumber}.pkpass"`,
      "cache-control": "no-store"
    }
  });
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlText(value: string): string {
  return base64Url(textEncoder.encode(value));
}

function pemToBytes(pem: string): Uint8Array {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function apnsJwt(env: Env): Promise<string> {
  if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_PRIVATE_KEY) {
    throw new Error("APNs is not configured");
  }
  const header = base64UrlText(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }));
  const payload = base64UrlText(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) }));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(env.APNS_PRIVATE_KEY),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    textEncoder.encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${base64Url(signature)}`;
}

function normalizedPushToken(token: string): string {
  return token.replace(/[<>\s]/g, "");
}

async function notifyPass(request: Request, env: Env, key: PassKey): Promise<Response> {
  if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
  const pass = await getPass(env, key);
  if (!pass) return json({ error: "pass_not_found" }, 404);
  await touchPass(env, key);

  const devices = await env.DB.prepare(
    `SELECT d.push_token FROM devices d
     JOIN registrations r ON r.device_library_identifier = d.device_library_identifier
     WHERE r.pass_type_identifier = ? AND r.serial_number = ?`
  ).bind(key.passTypeIdentifier, key.serialNumber).all<{ push_token: string }>();

  if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_PRIVATE_KEY) {
    return json({ ok: true, notified: 0, registeredDevices: devices.results.length, apns: "not_configured" });
  }

  const jwt = await apnsJwt(env);
  const host = env.APNS_ENVIRONMENT === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const results = await Promise.all(devices.results.map(async ({ push_token }) => {
    const response = await fetch(`https://${host}/3/device/${normalizedPushToken(push_token)}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-topic": key.passTypeIdentifier,
        "content-type": "application/json"
      },
      body: JSON.stringify({ aps: {} })
    });
    return { status: response.status, ok: response.ok };
  }));
  return json({ ok: results.every((result) => result.ok), notified: results.filter((result) => result.ok).length, results });
}

async function adminUpsertPass(request: Request, env: Env, key: PassKey): Promise<Response> {
  if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
  const body = await request.json().catch(() => null) as { authenticationToken?: string } | null;
  const existing = await getPass(env, key);
  const token = existing?.authentication_token ?? body?.authenticationToken;
  if (!token) return json({ error: "authenticationToken is required" }, 400);
  await env.DB.prepare(
    `INSERT INTO passes(pass_type_identifier, serial_number, authentication_token)
     VALUES (?, ?, ?)
     ON CONFLICT(pass_type_identifier, serial_number)
     DO UPDATE SET authentication_token = excluded.authentication_token`
  ).bind(key.passTypeIdentifier, key.serialNumber, token).run();
  return json({ ok: true, passTypeIdentifier: key.passTypeIdentifier, serialNumber: key.serialNumber });
}

async function adminUploadPass(request: Request, env: Env, key: PassKey): Promise<Response> {
  if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
  const existing = await getPass(env, key);
  if (!existing) return json({ error: "create_pass_first" }, 404);
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return json({ error: "pkpass_body_is_empty" }, 400);
  await env.DB.prepare(
    `UPDATE passes SET pkpass = ?,
      updated_at = CAST(MAX(CAST(updated_at AS INTEGER) + 1, CAST(strftime('%s', 'now') AS INTEGER)) AS TEXT)
     WHERE pass_type_identifier = ? AND serial_number = ?`
  ).bind(body, key.passTypeIdentifier, key.serialNumber).run();
  return json({ ok: true, bytes: body.byteLength });
}

async function adminUpdatePass(request: Request, env: Env, key: PassKey): Promise<Response> {
  if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
  const existing = await getPass(env, key);
  if (!existing) return json({ error: "pass_not_found" }, 404);
  await touchPass(env, key);
  return json({ ok: true, message: "pass marked as updated; call /notify to send APNs" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });

      const registration = url.pathname.match(/^\/apple-wallet\/v1\/devices\/([^/]+)\/registrations\/([^/]+)\/([^/]+)$/);
      if (registration) {
        const [, deviceId, passTypeIdentifier, serialNumber] = registration;
        const key = passKey(passTypeIdentifier, serialNumber);
        if (request.method === "POST") return register(request, env, key, decodeURIComponent(deviceId));
        if (request.method === "DELETE") return unregister(request, env, key, decodeURIComponent(deviceId));
      }

      const list = url.pathname.match(/^\/apple-wallet\/v1\/devices\/([^/]+)\/registrations\/([^/]+)$/);
      if (request.method === "GET" && list) {
        return changedPasses(request, env, decodeURIComponent(list[1]), decodeURIComponent(list[2]));
      }

      const pass = url.pathname.match(/^\/apple-wallet\/v1\/passes\/([^/]+)\/([^/]+)$/);
      if (request.method === "GET" && pass) return downloadPass(request, env, passKey(pass[1], pass[2]));

      const install = url.pathname.match(/^\/install\/([^/]+)\/([^/]+)$/);
      if (request.method === "GET" && install) return installPass(request, env, passKey(install[1], install[2]));

      const admin = url.pathname.match(/^\/admin\/passes\/([^/]+)\/([^/]+)(?:\/(pkpass|notify))?$/);
      if (admin) {
        const key = passKey(admin[1], admin[2]);
        if (!admin[3] && request.method === "PUT") return adminUpsertPass(request, env, key);
        if (admin[3] === "pkpass" && request.method === "PUT") return adminUploadPass(request, env, key);
        if (admin[3] === "notify" && request.method === "POST") return notifyPass(request, env, key);
        if (admin[3] === undefined && request.method === "POST") return adminUpdatePass(request, env, key);
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: "internal_error" }, 500);
    }
  }
};
