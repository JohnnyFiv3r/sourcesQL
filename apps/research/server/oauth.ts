import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const OAUTH_ACCESS_SCOPE = "sourcesql:access";

export type OAuthConfiguration = Readonly<{
  issuer: string;
  audience: string;
  subject: string;
  jwksUri: string;
}>;

export type OAuthFailure = "invalid_token" | "insufficient_scope";
export type OAuthVerification =
  { authenticated: true } | { authenticated: false; reason: OAuthFailure };

function trustedHttpsUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an explicit public HTTPS URL`);
  }
  const hostname = url.hostname;
  const labels = hostname.split(".");
  if (
    value.trim() !== value ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    hostname.length > 253 ||
    labels.length < 2 ||
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
    ) ||
    !/[a-z]/i.test(labels.at(-1)!) ||
    /(?:^|\.)(?:localhost|local|internal|home)$/i.test(hostname) ||
    !value.startsWith(url.origin)
  )
    throw new Error(`${name} must be an explicit public HTTPS URL`);
  return url;
}

function trustedOrigin(value: string, name: string): string {
  const url = trustedHttpsUrl(value, name);
  if (value !== url.origin && value !== `${url.origin}/`)
    throw new Error(`${name} must be an HTTPS origin without a path`);
  return url.origin;
}

function validateConfiguration(config: OAuthConfiguration): OAuthConfiguration {
  const issuerOrigin = trustedOrigin(config.issuer, "OAuth issuer");
  const audience = trustedHttpsUrl(config.audience, "OAuth audience");
  if (config.audience !== `${audience.origin}/mcp`)
    throw new Error("OAuth audience must be the canonical HTTPS /mcp resource");
  const jwks = trustedHttpsUrl(config.jwksUri, "OAuth JWKS URI");
  if (jwks.origin !== issuerOrigin || jwks.pathname === "/")
    throw new Error(
      "OAuth JWKS URI must be a path on the trusted issuer origin",
    );
  if (
    !config.subject ||
    config.subject.length > 512 ||
    config.subject.trim() !== config.subject ||
    /[\u0000-\u001f\u007f]/.test(config.subject)
  )
    throw new Error("OAuth requires one explicit immutable owner subject");
  return Object.freeze({ ...config });
}

export function readOAuthConfiguration(
  environment: NodeJS.ProcessEnv,
): OAuthConfiguration | undefined {
  const values = [
    environment.SOURCESQL_OAUTH_ISSUER,
    environment.SOURCESQL_OAUTH_AUDIENCE,
    environment.SOURCESQL_OAUTH_SUBJECT,
    environment.SOURCESQL_OAUTH_JWKS_URI,
  ];
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => !value))
    throw new Error(
      "OAuth requires SOURCESQL_OAUTH_ISSUER, SOURCESQL_OAUTH_AUDIENCE, SOURCESQL_OAUTH_SUBJECT and SOURCESQL_OAUTH_JWKS_URI together",
    );
  return validateConfiguration({
    issuer: values[0]!,
    audience: values[1]!,
    subject: values[2]!,
    jwksUri: values[3]!,
  });
}

export function createOAuthVerifier(
  configuration: OAuthConfiguration,
  injectedJwks?: JWTVerifyGetKey,
) {
  const config = validateConfiguration(configuration);
  // The only fetched URL is trusted operator configuration, never a JWT's jku/x5u.
  // jose rejects redirects and caches keys; the injected resolver is for offline tests.
  const keys =
    injectedJwks ??
    createRemoteJWKSet(new URL(config.jwksUri), {
      timeoutDuration: 3000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
  return {
    async verify(header: string | undefined): Promise<OAuthVerification> {
      const token = /^Bearer ([^\s]{1,16384})$/i.exec(header ?? "")?.[1];
      if (!token) return { authenticated: false, reason: "invalid_token" };
      try {
        const { payload } = await jwtVerify(token, keys, {
          algorithms: ["RS256", "ES256"],
          issuer: config.issuer,
          audience: config.audience,
          subject: config.subject,
          requiredClaims: ["iss", "aud", "sub", "exp"],
          clockTolerance: 0,
        });
        if (
          typeof payload.scope !== "string" ||
          !payload.scope.split(" ").includes(OAUTH_ACCESS_SCOPE)
        )
          return { authenticated: false, reason: "insufficient_scope" };
        // All accepted identities represent exactly this deployment's configured
        // owner. Never return claims that could become a caller-selected principal.
        return { authenticated: true };
      } catch {
        return { authenticated: false, reason: "invalid_token" };
      }
    },
  };
}

export function oauthProtectedResource(
  configuration: OAuthConfiguration,
  publicOrigin: string,
) {
  const config = validateConfiguration(configuration);
  const origin = trustedOrigin(publicOrigin, "OAuth public origin");
  if (config.audience !== `${origin}/mcp`)
    throw new Error("OAuth audience must match the public MCP resource");
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [config.issuer],
    scopes_supported: [OAUTH_ACCESS_SCOPE],
    bearer_methods_supported: ["header"],
  };
}

export function oauthChallenge(publicOrigin: string, failure?: OAuthFailure) {
  const origin = trustedOrigin(publicOrigin, "OAuth public origin");
  const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="${OAUTH_ACCESS_SCOPE}"`;
  if (!failure) return challenge;
  if (failure === "insufficient_scope")
    return `${challenge}, error="insufficient_scope", error_description="The required sourcesQL workspace scope is missing"`;
  return `${challenge}, error="invalid_token", error_description="A valid token for this sourcesQL owner and resource is required"`;
}
