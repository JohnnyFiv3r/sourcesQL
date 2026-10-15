import test from "node:test";
import assert from "node:assert/strict";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JWTPayload,
} from "jose";
import {
  createOAuthVerifier,
  oauthChallenge,
  oauthProtectedResource,
  OAUTH_ACCESS_SCOPE,
  readOAuthConfiguration,
  type OAuthConfiguration,
} from "../server/oauth.js";

const environment = {
  SOURCESQL_OAUTH_ISSUER: "https://auth.sourcesql.example/",
  SOURCESQL_OAUTH_AUDIENCE: "https://sourcesql.example/mcp",
  SOURCESQL_OAUTH_SUBJECT: "opaque-owner-subject",
  SOURCESQL_OAUTH_JWKS_URI:
    "https://auth.sourcesql.example/.well-known/jwks.json",
};
const config = readOAuthConfiguration(environment)!;
const rsa = await generateKeyPair("RS256");
const ec = await generateKeyPair("ES256");
const wrongKey = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({
  keys: [
    { ...(await exportJWK(rsa.publicKey)), kid: "rsa", alg: "RS256" },
    { ...(await exportJWK(ec.publicKey)), kid: "ec", alg: "ES256" },
  ],
});
const verifier = createOAuthVerifier(config, jwks);
const now = Math.floor(Date.now() / 1000);
const claims: JWTPayload = {
  iss: config.issuer,
  aud: config.audience,
  sub: config.subject,
  exp: now + 600,
  iat: now,
  scope: OAUTH_ACCESS_SCOPE,
};
async function signed(
  overrides: JWTPayload = {},
  key = rsa.privateKey,
  algorithm = "RS256",
  kid = "rsa",
) {
  return new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg: algorithm, kid })
    .sign(key);
}
async function verify(overrides: JWTPayload = {}) {
  return verifier.verify(`Bearer ${await signed(overrides)}`);
}
const invalid = { authenticated: false, reason: "invalid_token" };
const insufficient = { authenticated: false, reason: "insufficient_scope" };

test("OAuth is disabled only when all configuration is absent", () => {
  assert.equal(readOAuthConfiguration({}), undefined);
  assert.deepEqual(readOAuthConfiguration(environment), {
    issuer: environment.SOURCESQL_OAUTH_ISSUER,
    audience: environment.SOURCESQL_OAUTH_AUDIENCE,
    subject: environment.SOURCESQL_OAUTH_SUBJECT,
    jwksUri: environment.SOURCESQL_OAUTH_JWKS_URI,
  });
  assert.equal(Object.isFrozen(config), true);
  for (const key of Object.keys(environment)) {
    const partial: NodeJS.ProcessEnv = { ...environment };
    delete partial[key];
    assert.throws(() => readOAuthConfiguration(partial), /requires/);
    assert.throws(
      () => readOAuthConfiguration({ ...environment, [key]: "" }),
      /requires/,
    );
  }
});

test("OAuth configuration rejects unsafe URLs, untrusted key origins and ambiguous resources", () => {
  const invalidIssuers = [
    "http://auth.sourcesql.example/",
    "https://localhost/",
    "https://api.localhost/",
    "https://metadata.google.internal/",
    "https://auth.local/",
    "https://127.0.0.1/",
    "https://169.254.169.254/",
    "https://[::1]/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://user:password@auth.sourcesql.example/",
    "https://auth.sourcesql.example:8443/",
    "https://auth.sourcesql.example/path",
    "https://auth.sourcesql.example/?query=value",
    "https://auth.sourcesql.example/#fragment",
    " https://auth.sourcesql.example/",
    "https://auth..sourcesql.example/",
    "https://auth.sourcesql.example./",
    "not a URL",
  ];
  for (const issuer of invalidIssuers)
    assert.throws(
      () =>
        readOAuthConfiguration({
          ...environment,
          SOURCESQL_OAUTH_ISSUER: issuer,
        }),
      /HTTPS/,
      issuer,
    );
  for (const audience of [
    "https://sourcesql.example",
    "https://sourcesql.example/mcp/",
    "https://sourcesql.example/mcp?x=1",
    "https://sourcesql.example/mcp#fragment",
    "https://user:password@sourcesql.example/mcp",
    "https://sourcesql.example/%6dcp",
    "http://sourcesql.example/mcp",
  ])
    assert.throws(() =>
      readOAuthConfiguration({
        ...environment,
        SOURCESQL_OAUTH_AUDIENCE: audience,
      }),
    );
  for (const jwksUri of [
    "https://attacker.example/.well-known/jwks.json",
    "https://auth.sourcesql.example/",
    "http://auth.sourcesql.example/.well-known/jwks.json",
    "https://127.0.0.1/.well-known/jwks.json",
    "https://auth.sourcesql.example/.well-known/jwks.json?key=secret",
    "https://auth.sourcesql.example/.well-known/jwks.json#fragment",
  ])
    assert.throws(() =>
      readOAuthConfiguration({
        ...environment,
        SOURCESQL_OAUTH_JWKS_URI: jwksUri,
      }),
    );
  for (const subject of ["", " ", " owner", "owner\n", "a".repeat(513)])
    assert.throws(() =>
      readOAuthConfiguration({
        ...environment,
        SOURCESQL_OAUTH_SUBJECT: subject,
      }),
    );
  assert.throws(() =>
    createOAuthVerifier({ ...config, jwksUri: "http://localhost/" }, jwks),
  );
});

test("OAuth verifies genuine RSA and EC signatures without returning identity claims", async () => {
  assert.deepEqual(await verify(), { authenticated: true });
  const ecToken = await signed({}, ec.privateKey, "ES256", "ec");
  assert.deepEqual(await verifier.verify(`Bearer ${ecToken}`), {
    authenticated: true,
  });
  assert.deepEqual(await verifier.verify(`bearer ${await signed()}`), {
    authenticated: true,
  });
  // OIDC issuers can include userinfo alongside the exact API audience.
  assert.deepEqual(
    await verify({ aud: [config.audience, `${config.issuer}userinfo`] }),
    { authenticated: true },
  );
});

test("OAuth refuses a different authenticated owner, issuer, audience or missing identity", async () => {
  for (const overrides of [
    { sub: "another-valid-user" },
    { sub: config.subject.toUpperCase() },
    { sub: undefined },
    { iss: "https://other.sourcesql.example/" },
    { iss: config.issuer.slice(0, -1) },
    { iss: undefined },
    { aud: "https://sourcesql.example/another-api" },
    { aud: `${config.audience}/suffix` },
    { aud: [`${config.audience}/suffix`] },
    { aud: undefined },
  ])
    assert.deepEqual(await verify(overrides), invalid);
});

test("OAuth requires expiry and enforces expiry and not-before with no grace window", async () => {
  assert.deepEqual(await verify({ exp: now - 1 }), invalid);
  assert.deepEqual(await verify({ exp: undefined }), invalid);
  assert.deepEqual(await verify({ nbf: now + 3600 }), invalid);
  assert.deepEqual(await verify({ nbf: now - 1 }), { authenticated: true });
});

test("OAuth requires the exact workspace scope in a space-delimited string", async () => {
  assert.deepEqual(
    await verify({ scope: `openid ${OAUTH_ACCESS_SCOPE} email` }),
    {
      authenticated: true,
    },
  );
  for (const scope of [
    undefined,
    "",
    "openid email",
    "sourcesql:access-admin",
    "prefix:sourcesql:access",
    [OAUTH_ACCESS_SCOPE],
  ])
    assert.deepEqual(await verify({ scope }), insufficient);
});

test("OAuth rejects forged, unsigned, malformed and symmetric-confusion tokens", async () => {
  const forged = await signed({}, wrongKey.privateKey);
  assert.deepEqual(await verifier.verify(`Bearer ${forged}`), invalid);
  const unsigned = [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "",
  ].join(".");
  assert.deepEqual(await verifier.verify(`Bearer ${unsigned}`), invalid);
  const symmetric = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", kid: "rsa" })
    .sign(new TextEncoder().encode(await exportSPKI(rsa.publicKey)));
  assert.deepEqual(await verifier.verify(`Bearer ${symmetric}`), invalid);
  for (const header of [
    undefined,
    "",
    "Basic synthetic",
    "Bearer invalid",
    `Bearer ${"a".repeat(16385)}`,
    `Bearer ${await signed()} extra`,
  ])
    assert.deepEqual(await verifier.verify(header), invalid);
});

test("JWT key URLs are ignored and key retrieval errors fail closed without disclosures", async () => {
  const token = await new SignJWT(claims)
    .setProtectedHeader({
      alg: "RS256",
      kid: "rsa",
      jku: "http://169.254.169.254/latest/meta-data/",
      x5u: "https://attacker.example/keys",
    })
    .sign(rsa.privateKey);
  assert.deepEqual(await verifier.verify(`Bearer ${token}`), {
    authenticated: true,
  });
  const unavailable = createOAuthVerifier(config, async () => {
    throw new Error("private operator detail must not escape");
  });
  assert.deepEqual(await unavailable.verify(`Bearer ${token}`), invalid);
});

test("Discovery and challenges identify the exact public resource and contain no caller data", () => {
  assert.deepEqual(
    oauthProtectedResource(config, "https://sourcesql.example"),
    {
      resource: config.audience,
      authorization_servers: [config.issuer],
      scopes_supported: [OAUTH_ACCESS_SCOPE],
      bearer_methods_supported: ["header"],
    },
  );
  assert.throws(() =>
    oauthProtectedResource(config, "https://another.sourcesql.example"),
  );
  assert.throws(() => oauthChallenge("https://user:secret@sourcesql.example"));
  assert.throws(() => oauthChallenge("https://sourcesql.example/other-path"));
  const firstChallenge = oauthChallenge("https://sourcesql.example");
  assert.equal(
    firstChallenge,
    'Bearer resource_metadata="https://sourcesql.example/.well-known/oauth-protected-resource", scope="sourcesql:access"',
  );
  assert.equal(firstChallenge.includes("error="), false);
  for (const failure of ["invalid_token", "insufficient_scope"] as const) {
    const challenge = oauthChallenge("https://sourcesql.example", failure);
    assert.ok(challenge.includes(`error="${failure}"`));
    assert.ok(challenge.includes('error_description="'));
    assert.equal(challenge.includes(config.subject), false);
  }
});

test("Configuration has no authorization-server discovery guesses or default key URL", () => {
  const noKeys: NodeJS.ProcessEnv = { ...environment };
  delete noKeys.SOURCESQL_OAUTH_JWKS_URI;
  assert.throws(() => readOAuthConfiguration(noKeys), /JWKS_URI/);
  const otherPath: OAuthConfiguration = {
    ...config,
    jwksUri: "https://auth.sourcesql.example/oauth2/keys",
  };
  assert.ok(createOAuthVerifier(otherPath, jwks));
});
