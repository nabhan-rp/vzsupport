const PUBLIC_TICKET_PATH = "/api/public/tickets";
const MAX_REQUEST_BYTES = 16 * 1024;
const ACCESS_KEYS_TTL_MS = 5 * 60 * 1000;

let accessSigningKeys;
let accessSigningKeysUntil = 0;
let accessSigningKeysTeam;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    try {
      if (pathname === PUBLIC_TICKET_PATH) {
        if (request.method === "OPTIONS") {
          const originError = validatePublicOrigin(request, env);
          if (originError) return publicCorsResponse(request, env, originError);
          return publicCorsResponse(request, env, new Response(null, { status: 204 }));
        }
        if (request.method !== "POST") {
          return publicCorsResponse(
            request,
            env,
            json({ error: "Method not allowed" }, 405)
          );
        }
        return await createPublicTicket(request, env);
      }

      const closeMatch = pathname.match(/^\/api\/tickets\/(\d+)\/close$/);
      const staffRoute =
        pathname === "/" || pathname === "/api/tickets" || Boolean(closeMatch);

      if (staffRoute) {
        const accessError = await requireStaffAccess(request, env);
        if (accessError) return accessError;
      }

      if (pathname === "/" && request.method === "GET") {
        return technicianPage();
      }
      if (pathname === "/api/tickets" && request.method === "GET") {
        return await listTickets(env);
      }
      if (pathname === "/api/tickets" && request.method === "POST") {
        return await createStaffTicket(request, env);
      }
      if (closeMatch && request.method === "POST") {
        return await closeTicket(closeMatch[1], env);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (!(error instanceof RequestError)) {
        console.error("VZ Support request failed", error);
      }
      const response =
        error instanceof RequestError
          ? json({ error: error.message }, error.status)
          : json({ error: "The request could not be completed" }, 500);
      return pathname === PUBLIC_TICKET_PATH
        ? publicCorsResponse(request, env, response)
        : response;
    }
  },
};

async function listTickets(env) {
  if (!env.SUPPORT_DB) {
    return json({ error: "Ticket database is not configured" }, 503);
  }
  const { results } = await env.SUPPORT_DB.prepare(
    "SELECT id, customer_name, reporter_email, category, target_url, subject, body, status, created_at FROM tickets ORDER BY created_at DESC LIMIT 100"
  ).all();
  return json({ tickets: results });
}

async function createStaffTicket(request, env) {
  const payload = await readJson(request);
  const ticket = {
    customerName: requiredText(payload.customer_name, "customer_name", 120),
    reporterEmail: optionalEmail(payload.reporter_email),
    category: optionalText(payload.category, 80),
    targetUrl: optionalUrl(payload.target_url),
    subject: requiredText(payload.subject, "subject", 200),
    body: requiredText(payload.body, "body", 10000),
  };
  if (!env.SUPPORT_DB) {
    return json({ error: "Ticket database is not configured" }, 503);
  }

  const result = await insertTicket(env.SUPPORT_DB, ticket);
  return json({ ok: true, id: result.meta.last_row_id }, 201);
}

async function createPublicTicket(request, env) {
  const originError = validatePublicOrigin(request, env);
  if (originError) return publicCorsResponse(request, env, originError);

  const payload = await readJson(request);
  const ticket = {
    customerName: requiredText(payload.customerName, "customerName", 120),
    reporterEmail: requiredEmail(payload.reporterEmail),
    category: optionalText(payload.category, 80),
    targetUrl: optionalUrl(payload.targetUrl),
    subject: requiredText(payload.subject, "subject", 200),
    body: requiredText(payload.body, "body", 10000),
  };
  const turnstileToken = requiredText(payload.turnstileToken, "turnstileToken", 2048);

  if (!env.SUPPORT_DB) {
    return publicCorsResponse(
      request,
      env,
      json({ error: "Ticket database is not configured" }, 503)
    );
  }
  if (!(await verifyTurnstile(turnstileToken, request, env))) {
    return publicCorsResponse(
      request,
      env,
      json({ error: "Human verification failed" }, 403)
    );
  }

  const result = await insertTicket(env.SUPPORT_DB, ticket);
  const id = result.meta.last_row_id;
  return publicCorsResponse(
    request,
    env,
    json(
      {
        ok: true,
        ticket: {
          id,
          reference: `VZ-${new Date().getUTCFullYear()}-${String(id).padStart(6, "0")}`,
        },
      },
      201
    )
  );
}

function insertTicket(database, ticket) {
  return database
    .prepare(
      "INSERT INTO tickets (customer_name, reporter_email, category, target_url, subject, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    )
    .bind(
      ticket.customerName,
      ticket.reporterEmail,
      ticket.category,
      ticket.targetUrl,
      ticket.subject,
      ticket.body
    )
    .run();
}

async function closeTicket(id, env) {
  if (!env.SUPPORT_DB) {
    return json({ error: "Ticket database is not configured" }, 503);
  }
  const result = await env.SUPPORT_DB.prepare(
    "UPDATE tickets SET status = 'closed' WHERE id = ?1 AND status = 'open'"
  )
    .bind(Number(id))
    .run();
  if (!result.meta.changes) {
    return json({ error: "Ticket not found or already closed" }, 404);
  }
  return json({ ok: true });
}

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function requireStaffAccess(request, env) {
  const teamDomain = normalizeAccessTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const audience = env.ACCESS_AUD?.trim();
  if (!teamDomain || !audience) {
    return json({ error: "Staff access is not configured" }, 503);
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    return json({ error: "Cloudflare Access authentication required" }, 401);
  }
  const parts = token.split(".");
  if (parts.length !== 3) return json({ error: "Invalid Access token" }, 401);

  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
  } catch {
    return json({ error: "Invalid Access token" }, 401);
  }

  if (
    !header ||
    typeof header !== "object" ||
    !claims ||
    typeof claims !== "object" ||
    header.alg !== "RS256" ||
    typeof header.kid !== "string"
  ) {
    return json({ error: "Invalid Access token" }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    claims.iss !== `https://${teamDomain}` ||
    !audienceMatches(claims.aud, audience) ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    (typeof claims.nbf === "number" && claims.nbf > now) ||
    typeof claims.email !== "string"
  ) {
    return json({ error: "Access token is not authorized for this application" }, 401);
  }

  const signingKey = await getAccessSigningKey(teamDomain, header.kid);
  try {
    const isValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      signingKey,
      decodeBase64Url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (isValid) return null;
  } catch {
    return json({ error: "Invalid Access token signature" }, 401);
  }
  return json({ error: "Invalid Access token signature" }, 401);
}

function normalizeAccessTeamDomain(value) {
  if (typeof value !== "string") return "";
  const domain = value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return /^[a-z0-9.-]+$/i.test(domain) ? domain : "";
}

function audienceMatches(claim, expected) {
  return Array.isArray(claim) ? claim.includes(expected) : claim === expected;
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function getAccessSigningKey(teamDomain, keyId) {
  if (
    !accessSigningKeys ||
    accessSigningKeysTeam !== teamDomain ||
    accessSigningKeysUntil <= Date.now()
  ) {
    const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Could not load Cloudflare Access signing keys (${response.status})`);
    }
    const certificateSet = await response.json();
    if (!Array.isArray(certificateSet.jwk_public_certs)) {
      throw new Error("Cloudflare Access returned no JWK signing keys");
    }

    const signingKeys = new Map();
    for (const publicKey of certificateSet.jwk_public_certs) {
      if (publicKey.kid && publicKey.kty === "RSA" && publicKey.n && publicKey.e) {
        signingKeys.set(
          publicKey.kid,
          await crypto.subtle.importKey(
            "jwk",
            { kty: "RSA", n: publicKey.n, e: publicKey.e, alg: "RS256", ext: true },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"]
          )
        );
      }
    }
    accessSigningKeys = signingKeys;
    accessSigningKeysTeam = teamDomain;
    accessSigningKeysUntil = Date.now() + ACCESS_KEYS_TTL_MS;
  }

  const key = accessSigningKeys.get(keyId);
  if (!key) throw new RequestError("Unknown Cloudflare Access signing key", 401);
  return key;
}

async function readJson(request) {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new RequestError("Content-Type must be application/json", 415);
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new RequestError("Request body is too large", 413);
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new RequestError("Request body must be valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RequestError("Request body must be a JSON object");
  }
  return payload;
}

function requiredText(value, field, maxLength) {
  if (typeof value !== "string") throw new RequestError(`${field} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new RequestError(`${field} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function optionalText(value, maxLength) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new RequestError(`Optional text must be no longer than ${maxLength} characters`);
  }
  return value.trim() || null;
}

function requiredEmail(value) {
  const email = requiredText(value, "reporterEmail", 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new RequestError("reporterEmail must be a valid email address");
  }
  return email;
}

function optionalEmail(value) {
  if (value === undefined || value === null || value === "") return null;
  return requiredEmail(value);
}

function optionalUrl(value) {
  const targetUrl = optionalText(value, 2048);
  if (!targetUrl) return null;
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    throw new RequestError("targetUrl must be an absolute HTTP or HTTPS URL");
  }
  if (
    !["http:", "https:"].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new RequestError("targetUrl must be an absolute HTTP or HTTPS URL");
  }
  return parsedUrl.toString();
}

function allowedPublicOrigins(env) {
  return (env.PUBLIC_FORM_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function validatePublicOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin || !allowedPublicOrigins(env).includes(origin)) {
    return json({ error: "Origin is not allowed" }, 403);
  }
  return null;
}

function publicCorsResponse(request, env, response) {
  const origin = request.headers.get("origin");
  const headers = new Headers(response.headers);
  headers.set("Vary", "Origin");
  headers.set("Cache-Control", "no-store");
  if (origin && allowedPublicOrigins(env).includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "600");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function verifyTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_EXPECTED_HOSTNAMES) {
    throw new RequestError("Public ticket verification is not configured", 503);
  }
  const form = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  const sourceIp = request.headers.get("cf-connecting-ip");
  if (sourceIp) form.set("remoteip", sourceIp);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Turnstile verification failed (${response.status})`);
  }
  const result = await response.json();
  const allowedHostnames = env.TURNSTILE_EXPECTED_HOSTNAMES
    .split(",")
    .map((hostname) => hostname.trim())
    .filter(Boolean);
  return result.success === true && allowedHostnames.includes(result.hostname);
}

function technicianPage() {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>VZ Support · Technician Console</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #172033; background: #f4f7fb; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; }
      header { color: white; background: linear-gradient(115deg, #123f54, #176b70 58%, #5263a6); padding: 28px max(24px, calc((100vw - 1120px) / 2)); }
      header p { margin: 6px 0 0; color: #d3e6ee; }
      main { max-width: 1120px; margin: 28px auto; padding: 0 20px; display: grid; grid-template-columns: minmax(250px, 0.75fr) minmax(0, 1.5fr); gap: 20px; }
      section { background: white; border: 1px solid #e1e7ef; border-radius: 14px; padding: 20px; box-shadow: 0 5px 20px #16304c0a; }
      h1 { margin: 0; font-size: 1.35rem; } h2 { margin: 0 0 16px; font-size: 1.05rem; }
      label { display: block; margin: 12px 0 5px; font-size: .82rem; font-weight: 650; }
      input, textarea { width: 100%; padding: 10px 11px; border: 1px solid #ccd5e1; border-radius: 8px; font: inherit; }
      textarea { min-height: 110px; resize: vertical; }
      button { border: 0; border-radius: 8px; padding: 10px 14px; color: white; background: #176b70; font: inherit; font-weight: 650; cursor: pointer; }
      button:disabled { opacity: .6; cursor: wait; }
      .form-actions, .list-heading, .ticket-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .form-actions { margin-top: 16px; }
      .muted, .ticket-meta { color: #68758a; font-size: .84rem; }
      #notice { min-height: 1.2em; color: #176b70; font-size: .85rem; }
      #tickets { display: grid; gap: 12px; margin-top: 14px; }
      .ticket { border: 1px solid #e1e7ef; border-radius: 10px; padding: 14px; }
      .ticket h3 { margin: 0; font-size: .98rem; }
      .ticket p { white-space: pre-wrap; overflow-wrap: anywhere; }
      .ticket button { padding: 6px 10px; background: #eef4f7; color: #24485b; font-size: .8rem; }
      .ticket button:disabled { color: #667; }
      .empty { color: #68758a; text-align: center; padding: 28px 8px; }
      @media (max-width: 720px) { main { grid-template-columns: 1fr; margin-top: 16px; } header { padding: 22px 20px; } }
    </style>
  </head>
  <body>
    <header>
      <h1>VZ Support</h1>
      <p>Technician console · secure Cloudflare Access session</p>
    </header>
    <main>
      <section aria-labelledby="create-heading">
        <h2 id="create-heading">Create internal ticket</h2>
        <form id="create-form">
          <label for="customer-name">Customer name</label>
          <input id="customer-name" name="customer_name" maxlength="120" required>
          <label for="reporter-email">Contact email (optional)</label>
          <input id="reporter-email" name="reporter_email" type="email" maxlength="254">
          <label for="subject">Subject</label>
          <input id="subject" name="subject" maxlength="200" required>
          <label for="body">Details</label>
          <textarea id="body" name="body" maxlength="10000" required></textarea>
          <div class="form-actions">
            <span id="notice" role="status" aria-live="polite"></span>
            <button id="submit-button" type="submit">Create ticket</button>
          </div>
        </form>
      </section>
      <section aria-labelledby="tickets-heading">
        <div class="list-heading">
          <div>
            <h2 id="tickets-heading">Recent tickets</h2>
            <div class="muted">Showing up to 100 most recent tickets.</div>
          </div>
          <button id="refresh-button" type="button">Refresh</button>
        </div>
        <div id="tickets" aria-live="polite"><div class="empty">Loading tickets…</div></div>
      </section>
    </main>
    <script>
      const ticketsElement = document.getElementById("tickets");
      const notice = document.getElementById("notice");
      const form = document.getElementById("create-form");
      const submitButton = document.getElementById("submit-button");

      async function requestJson(path, options) {
        const response = await fetch(path, options);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Request failed.");
        return result;
      }

      function makeTextElement(tag, className, value) {
        const element = document.createElement(tag);
        element.className = className;
        element.textContent = value || "";
        return element;
      }

      function renderTickets(tickets) {
        ticketsElement.replaceChildren();
        if (tickets.length === 0) {
          ticketsElement.append(makeTextElement("div", "empty", "No tickets yet."));
          return;
        }
        for (const ticket of tickets) {
          const card = document.createElement("article");
          card.className = "ticket";
          const heading = document.createElement("div");
          heading.className = "ticket-heading";
          heading.append(makeTextElement("h3", "", ticket.subject));
          heading.append(makeTextElement("span", "muted", ticket.status.toUpperCase()));
          card.append(heading);
          card.append(makeTextElement(
            "div",
            "ticket-meta",
            [ticket.customer_name, ticket.reporter_email, ticket.category, "#" + ticket.id, ticket.created_at]
              .filter(Boolean)
              .join(" · ")
          ));
          if (ticket.target_url) {
            const target = makeTextElement("p", "ticket-meta", ticket.target_url);
            card.append(target);
          }
          const details = document.createElement("details");
          details.append(makeTextElement("summary", "", "View details"));
          details.append(makeTextElement("p", "", ticket.body));
          card.append(details);
          if (ticket.status === "open") {
            const closeButton = document.createElement("button");
            closeButton.type = "button";
            closeButton.textContent = "Close ticket";
            closeButton.addEventListener("click", () => closeTicket(ticket.id, closeButton));
            card.append(closeButton);
          }
          ticketsElement.append(card);
        }
      }

      async function loadTickets() {
        ticketsElement.replaceChildren(makeTextElement("div", "empty", "Loading tickets…"));
        try {
          const result = await requestJson("/api/tickets");
          renderTickets(result.tickets);
        } catch (error) {
          ticketsElement.replaceChildren(
            makeTextElement("div", "empty", error.message || "Unable to load tickets.")
          );
        }
      }

      async function closeTicket(id, button) {
        if (!confirm("Close ticket #" + id + "?")) return;
        button.disabled = true;
        try {
          await requestJson("/api/tickets/" + id + "/close", { method: "POST" });
          notice.textContent = "Ticket #" + id + " closed.";
          await loadTickets();
        } catch (error) {
          notice.textContent = error.message || "Unable to close ticket.";
          button.disabled = false;
        }
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        submitButton.disabled = true;
        notice.textContent = "";
        const formData = new FormData(form);
        const payload = Object.fromEntries(formData.entries());
        try {
          const result = await requestJson("/api/tickets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          notice.textContent = "Ticket #" + result.id + " created.";
          form.reset();
          await loadTickets();
        } catch (error) {
          notice.textContent = error.message || "Unable to create ticket.";
        } finally {
          submitButton.disabled = false;
        }
      });

      document.getElementById("refresh-button").addEventListener("click", loadTickets);
      loadTickets();
    </script>
  </body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
