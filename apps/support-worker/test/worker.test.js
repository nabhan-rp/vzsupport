import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const publicOrigin = "https://vz.gay";
const supportOrigin = "https://support.vz.gay";

function makeRequest(path, { method = "GET", headers = {}, body } = {}) {
  return new Request(`https://support.vz.gay${path}`, {
    method,
    headers,
    body,
  });
}

function makeDatabase() {
  const calls = [];
  return {
    calls,
    prepare(query) {
      return {
        bind(...values) {
          return {
            async run() {
              calls.push({ query, values });
              return { meta: { last_row_id: 42, changes: 1 } };
            },
            async first() {
              calls.push({ query, values });
              return null;
            },
          };
        },
      };
    },
  };
}

function makeLookupDatabase(ticket) {
  const calls = [];
  return {
    calls,
    prepare(query) {
      return {
        bind(...values) {
          return {
            async first() {
              calls.push({ query, values });
              return ticket;
            },
          };
        },
      };
    },
  };
}

test("staff ticket APIs reject requests without Cloudflare Access", async () => {
  const response = await worker.fetch(
    makeRequest("/api/tickets"),
    {
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUD: "access-audience",
    }
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: "Cloudflare Access authentication required",
  });
});

test("staff ticket APIs verify Cloudflare Access signatures and audience", async (t) => {
  const teamDomain = `test-${crypto.randomUUID()}.cloudflareaccess.com`;
  const audience = "vz-support-test-audience";
  const keyId = "test-key";
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: keyId };
  const previousFetch = globalThis.fetch;
  let certificateSet = { jwk_public_certs: [jwk] };
  globalThis.fetch = async (input) => {
    assert.match(input, /^https:\/\/test-[\w-]+\.cloudflareaccess\.com\/cdn-cgi\/access\/certs$/);
    return Response.json(certificateSet);
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const createToken = async (tokenTeamDomain) => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "RS256", kid: keyId, typ: "JWT" });
    const claims = encode({
      iss: `https://${tokenTeamDomain}`,
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 60,
      email: "agent@vz.gay",
    });
    const signingInput = `${header}.${claims}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(signingInput)
    );
    return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
  };
  const makeAccessEnv = (accessTeamDomain) => ({
    ACCESS_TEAM_DOMAIN: accessTeamDomain,
    ACCESS_AUD: audience,
    SUPPORT_DB: {
      prepare() {
        return { async all() { return { results: [] }; } };
      },
    },
  });
  const token = await createToken(teamDomain);

  const validResponse = await worker.fetch(
    makeRequest("/api/tickets", {
      headers: { "cf-access-jwt-assertion": token },
    }),
    makeAccessEnv(teamDomain)
  );
  assert.equal(validResponse.status, 200);
  assert.deepEqual(await validResponse.json(), { tickets: [] });

  const adminResponse = await worker.fetch(
    makeRequest("/admin", {
      headers: { "cf-access-jwt-assertion": token },
    }),
    makeAccessEnv(teamDomain)
  );
  assert.equal(adminResponse.status, 200);
  assert.match(await adminResponse.text(), /Technician Console/);

  const signaturePart = token.slice(token.lastIndexOf(".") + 1);
  const invalidSignature = `${token.slice(0, token.lastIndexOf(".") + 1)}${signaturePart[0] === "A" ? "B" : "A"}${signaturePart.slice(1)}`;
  const rejectedResponse = await worker.fetch(
    makeRequest("/api/tickets", {
      headers: { "cf-access-jwt-assertion": invalidSignature },
    }),
    makeAccessEnv(teamDomain)
  );
  assert.equal(rejectedResponse.status, 401);

  certificateSet = { keys: [jwk] };
  const fallbackTeamDomain = `test-${crypto.randomUUID()}.cloudflareaccess.com`;
  const fallbackResponse = await worker.fetch(
    makeRequest("/api/tickets", {
      headers: {
        "cf-access-jwt-assertion": await createToken(fallbackTeamDomain),
      },
    }),
    makeAccessEnv(fallbackTeamDomain)
  );
  assert.equal(fallbackResponse.status, 200);
});

test("public homepage serves ticket submission and lookup without Access", async () => {
  const response = await worker.fetch(makeRequest("/"), {});
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Customer Care/);
  assert.match(html, /data-sitekey="0x4AAAAAAGWaOorjmzmCqhEP"/);
  assert.match(html, /data-callback="onTurnstileSuccess"/);
  assert.match(html, /fetch\("\/api\/public\/tickets"/);
  assert.match(html, /\/api\/public\/tickets\/lookup\?/);
  assert.doesNotMatch(html, /Technician Console/);
});

test("technician console moved to Access-protected /admin", async () => {
  const response = await worker.fetch(
    makeRequest("/admin"),
    {
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUD: "access-audience",
    }
  );
  assert.equal(response.status, 401);

  const publicAdminResponse = await worker.fetch(makeRequest("/admin"), {});
  assert.equal(publicAdminResponse.status, 503);

  const closeResponse = await worker.fetch(
    makeRequest("/api/tickets/42/close", { method: "POST" }),
    {
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUD: "access-audience",
    }
  );
  assert.equal(closeResponse.status, 401);
});

test("public ticket lookup validates reference and email before querying D1", async () => {
  const database = makeLookupDatabase(null);
  const response = await worker.fetch(
    makeRequest("/api/public/tickets/lookup?reference=not-a-reference&email=ada%40example.com"),
    { SUPPORT_DB: database }
  );
  assert.equal(response.status, 400);
  assert.equal(database.calls.length, 0);

  const invalidEmail = await worker.fetch(
    makeRequest("/api/public/tickets/lookup?reference=VZ-2026-000042&email=invalid"),
    { SUPPORT_DB: database }
  );
  assert.equal(invalidEmail.status, 400);
  assert.equal(database.calls.length, 0);
});

test("public ticket lookup returns matching status and report body only", async () => {
  const createdAt = `${new Date().getUTCFullYear()}-11-28 01:23:45`;
  const database = makeLookupDatabase({
    id: 42,
    subject: "Help with account",
    body: "Please review the account issue.",
    status: "open",
    created_at: createdAt,
  });
  const response = await worker.fetch(
    makeRequest(
      `/api/public/tickets/lookup?reference=VZ-${new Date().getUTCFullYear()}-000042&email=ADA%40EXAMPLE.COM`
    ),
    { SUPPORT_DB: database }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    ticket: {
      id: 42,
      reference: `VZ-${new Date().getUTCFullYear()}-000042`,
      subject: "Help with account",
      body: "Please review the account issue.",
      status: "open",
      created_at: createdAt,
    },
  });
  assert.deepEqual(database.calls[0].values, [
    42,
    String(new Date().getUTCFullYear()),
    "ADA@EXAMPLE.COM",
  ]);
});

test("public ticket lookup uses the same not-found response for mismatched credentials", async () => {
  const database = makeLookupDatabase(null);
  const response = await worker.fetch(
    makeRequest("/api/public/tickets/lookup?reference=VZ-2026-000042&email=wrong%40example.com"),
    { SUPPORT_DB: database }
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "Ticket not found. Check the reference and email address.",
  });
});

test("public ticket preflight only allows the configured portal origin", async () => {
  const allowed = await worker.fetch(
    makeRequest("/api/public/tickets", {
      method: "OPTIONS",
      headers: { Origin: publicOrigin },
    }),
    { PUBLIC_FORM_ORIGINS: publicOrigin }
  );
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), publicOrigin);

  const denied = await worker.fetch(
    makeRequest("/api/public/tickets", {
      method: "OPTIONS",
      headers: { Origin: "https://attacker.example" },
    }),
    { PUBLIC_FORM_ORIGINS: publicOrigin }
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
});

test("public ticket intake rejects unapproved origins before parsing the payload", async () => {
  const response = await worker.fetch(
    makeRequest("/api/public/tickets", {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/json",
      },
      body: "{invalid",
    }),
    { PUBLIC_FORM_ORIGINS: publicOrigin }
  );

  assert.equal(response.status, 403);
});

test("public ticket intake reports malformed JSON with a client error", async () => {
  const response = await worker.fetch(
    makeRequest("/api/public/tickets", {
      method: "POST",
      headers: {
        Origin: publicOrigin,
        "Content-Type": "application/json",
      },
      body: "{invalid",
    }),
    { PUBLIC_FORM_ORIGINS: publicOrigin }
  );

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), publicOrigin);
});

test("public ticket intake rejects non-HTTP target URLs", async () => {
  const database = makeDatabase();
  const response = await worker.fetch(
    makeRequest("/api/public/tickets", {
      method: "POST",
      headers: {
        Origin: publicOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        customerName: "Ada",
        reporterEmail: "ada@example.com",
        subject: "Abuse report",
        body: "Please review this report.",
        targetUrl: "javascript:alert(1)",
        turnstileToken: "test-token",
      }),
    }),
    {
      SUPPORT_DB: database,
      PUBLIC_FORM_ORIGINS: publicOrigin,
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_EXPECTED_HOSTNAMES: "vz.gay",
    }
  );

  assert.equal(response.status, 400);
  assert.equal(database.calls.length, 0);
});

test("public ticket intake verifies Turnstile and persists a reference", async (t) => {
  const database = makeDatabase();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(
      input,
      "https://challenges.cloudflare.com/turnstile/v0/siteverify"
    );
    assert.equal(new URLSearchParams(init.body).get("secret"), "turnstile-secret");
    return Response.json({ success: true, hostname: "support.vz.gay" });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const response = await worker.fetch(
    makeRequest("/api/public/tickets", {
      method: "POST",
      headers: {
        Origin: supportOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        customerName: "Ada",
        reporterEmail: "ada@example.com",
        subject: "Abuse report",
        body: "Please review this report.",
        category: "abuse",
        targetUrl: "https://example.com/report",
        turnstileToken: "test-token",
      }),
    }),
    {
      SUPPORT_DB: database,
      PUBLIC_FORM_ORIGINS: `${publicOrigin},${supportOrigin}`,
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_EXPECTED_HOSTNAMES: "support.vz.gay",
    }
  );

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), supportOrigin);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.ticket.id, 42);
  assert.equal(
    result.ticket.reference,
    `VZ-${new Date().getUTCFullYear()}-000042`
  );
  assert.equal(database.calls.length, 1);
  assert.deepEqual(database.calls[0].values, [
    "Ada",
    "ada@example.com",
    "abuse",
    "https://example.com/report",
    "Abuse report",
    "Please review this report.",
  ]);
});

test("public ticket intake rejects Turnstile responses for another hostname", async (t) => {
  const database = makeDatabase();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ success: true, hostname: "attacker.example" });
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const response = await worker.fetch(
    makeRequest("/api/public/tickets", {
      method: "POST",
      headers: {
        Origin: publicOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        customerName: "Ada",
        reporterEmail: "ada@example.com",
        subject: "Abuse report",
        body: "Please review this report.",
        turnstileToken: "test-token",
      }),
    }),
    {
      SUPPORT_DB: database,
      PUBLIC_FORM_ORIGINS: publicOrigin,
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_EXPECTED_HOSTNAMES: "vz.gay",
    }
  );

  assert.equal(response.status, 403);
  assert.equal(database.calls.length, 0);
});
