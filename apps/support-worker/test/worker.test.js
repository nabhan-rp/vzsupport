import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const publicOrigin = "https://vz.gay";

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
  globalThis.fetch = async (input) => {
    assert.equal(input, `https://${teamDomain}/cdn-cgi/access/certs`);
    return Response.json({ jwk_public_certs: [jwk] });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: keyId, typ: "JWT" });
  const claims = encode({
    iss: `https://${teamDomain}`,
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
  const signaturePart = Buffer.from(signature).toString("base64url");
  const token = `${signingInput}.${signaturePart}`;
  const env = {
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUD: audience,
    SUPPORT_DB: {
      prepare() {
        return { async all() { return { results: [] }; } };
      },
    },
  };

  const validResponse = await worker.fetch(
    makeRequest("/api/tickets", {
      headers: { "cf-access-jwt-assertion": token },
    }),
    env
  );
  assert.equal(validResponse.status, 200);
  assert.deepEqual(await validResponse.json(), { tickets: [] });

  const invalidSignature = `${token.slice(0, token.lastIndexOf(".") + 1)}${signaturePart[0] === "A" ? "B" : "A"}${signaturePart.slice(1)}`;
  const rejectedResponse = await worker.fetch(
    makeRequest("/api/tickets", {
      headers: { "cf-access-jwt-assertion": invalidSignature },
    }),
    env
  );
  assert.equal(rejectedResponse.status, 401);
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
    return Response.json({ success: true, hostname: "vz.gay" });
  };
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
        category: "abuse",
        targetUrl: "https://example.com/report",
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

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), publicOrigin);
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
