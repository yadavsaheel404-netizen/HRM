import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AppUrlConfigError,
  buildSanitizedAuthPath,
  isRecoveryAuthLocation,
  parseAuthRecoveryLocation,
  resolveEmailPortalUrlFromEnv,
  resolvePasswordResetRedirectUrlFromEnv,
  stripSurroundingQuotes,
  validateEmailPortalUrl,
} from "../app-url";

const PROD = "https://hrm-theta-gilt.vercel.app";

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, "../../..", relativePath), "utf8");
}

describe("Forgot Password canonical URL normalization & quote handling", () => {
  it("strips accidental surrounding double or single quotes cleanly", () => {
    expect(stripSurroundingQuotes(`"${PROD}"`)).toBe(PROD);
    expect(stripSurroundingQuotes(`'  ${PROD}/  '`)).toBe(`${PROD}/`);
    expect(stripSurroundingQuotes(`  ${PROD}  `)).toBe(PROD);
    expect(stripSurroundingQuotes(undefined)).toBe("");
  });

  it("validates quoted and unquoted production URLs while rejecting localhost and HTTP", () => {
    expect(validateEmailPortalUrl(`"${PROD}/"`).ok).toBe(true);
    expect(validateEmailPortalUrl(`"${PROD}/"`).ok && validateEmailPortalUrl(`"${PROD}/"`))
      .toEqual({ ok: true, origin: PROD });
    expect(validateEmailPortalUrl('"http://localhost:3000"').ok).toBe(false);
    expect(validateEmailPortalUrl("http://hrm-theta-gilt.vercel.app").ok).toBe(false);
    expect(validateEmailPortalUrl("http://192.168.1.5").ok).toBe(false);
  });

  it("resolves password reset redirect strictly to production HTTPS when PUBLIC_APP_URL is set", () => {
    expect(
      resolvePasswordResetRedirectUrlFromEnv({
        PUBLIC_APP_URL: `"${PROD}"`,
        SITE_URL: "http://localhost:3000",
        VITE_SITE_URL: "http://localhost:3000",
        VERCEL_ENV: "production",
        NODE_ENV: "production",
      }),
    ).toBe(`${PROD}/auth/reset-password`);

    expect(
      resolveEmailPortalUrlFromEnv({
        PUBLIC_APP_URL: `'${PROD}'`,
        SITE_URL: "http://localhost:3000",
      }),
    ).toBe(PROD);
  });

  it("never falls back to localhost in production even if LOCAL_AUTH_REDIRECT_ORIGIN is set", () => {
    expect(() =>
      resolvePasswordResetRedirectUrlFromEnv({
        VERCEL_ENV: "production",
        SITE_URL: "http://localhost:3000",
        LOCAL_AUTH_REDIRECT_ORIGIN: "http://localhost:3000",
      }),
    ).toThrow(AppUrlConfigError);

    expect(() =>
      resolvePasswordResetRedirectUrlFromEnv({
        NODE_ENV: "production",
        LOCAL_AUTH_REDIRECT_ORIGIN: "http://localhost:3000",
      }),
    ).toThrow(AppUrlConfigError);
  });

  it("allows LOCAL_AUTH_REDIRECT_ORIGIN only in non-production when PUBLIC_APP_URL is empty", () => {
    expect(
      resolvePasswordResetRedirectUrlFromEnv({
        NODE_ENV: "development",
        LOCAL_AUTH_REDIRECT_ORIGIN: "http://localhost:3000",
      }),
    ).toBe("http://localhost:3000/auth/reset-password");

    // Rejects non-loopback local overrides and refuses silent localhost default when unset.
    expect(() =>
      resolvePasswordResetRedirectUrlFromEnv({
        NODE_ENV: "development",
        LOCAL_AUTH_REDIRECT_ORIGIN: "https://evil.example.com",
      }),
    ).toThrow(/LOCAL_AUTH_REDIRECT_ORIGIN/);

    expect(() =>
      resolvePasswordResetRedirectUrlFromEnv({
        NODE_ENV: "development",
      }),
    ).toThrow(AppUrlConfigError);
  });
});

describe("Auth recovery location parsing & history sanitization", () => {
  it("detects implicit recovery hash parameters and marks sensitive tokens for scrubbing", () => {
    const loc = {
      search: "",
      hash: "#access_token=abc123&refresh_token=def456&expires_in=3600&token_type=bearer&type=recovery",
    };
    const parsed = parseAuthRecoveryLocation(loc);
    expect(parsed.isRecoveryFlow).toBe(true);
    expect(parsed.effectiveType).toBe("recovery");
    expect(parsed.accessToken).toBe("abc123");
    expect(parsed.refreshToken).toBe("def456");
    expect(parsed.hasSensitiveParams).toBe(true);
    expect(isRecoveryAuthLocation(loc)).toBe(true);
    expect(buildSanitizedAuthPath("/auth/reset-password", loc.search)).toBe("/auth/reset-password");
  });

  it("detects PKCE query parameters and strips sensitive code/type from URL", () => {
    const loc = {
      search: "?code=pkce_code_xyz&type=recovery&next=%2Fauth%2Freset-password",
      hash: "",
    };
    const parsed = parseAuthRecoveryLocation(loc);
    expect(parsed.isRecoveryFlow).toBe(true);
    expect(parsed.code).toBe("pkce_code_xyz");
    expect(parsed.hasSensitiveParams).toBe(true);
    expect(buildSanitizedAuthPath("/auth/reset-password", loc.search)).toBe(
      "/auth/reset-password?next=%2Fauth%2Freset-password",
    );
  });

  it("detects custom token_hash recovery and setup=1 links", () => {
    const loc = {
      search: "?token_hash=th_999&type=recovery&setup=1",
      hash: "",
    };
    const parsed = parseAuthRecoveryLocation(loc);
    expect(parsed.isRecoveryFlow).toBe(true);
    expect(parsed.isSetupLink).toBe(true);
    expect(parsed.tokenHash).toBe("th_999");
    expect(parsed.hasSensitiveParams).toBe(true);
    expect(buildSanitizedAuthPath("/auth/reset-password", loc.search)).toBe(
      "/auth/reset-password?setup=1",
    );
  });

  it("extracts Supabase error hash parameters and clears error query/hash tokens", () => {
    const loc = {
      search: "",
      hash: "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    };
    const parsed = parseAuthRecoveryLocation(loc);
    expect(parsed.errorDescription).toBe("Email link is invalid or has expired");
    expect(parsed.hasSensitiveParams).toBe(true);
    expect(buildSanitizedAuthPath("/auth/reset-password", loc.search)).toBe("/auth/reset-password");
  });

  it("treats plain sign-in routes as non-recovery and preserves clean paths", () => {
    const loc = { search: "", hash: "" };
    const parsed = parseAuthRecoveryLocation(loc);
    expect(parsed.isRecoveryFlow).toBe(false);
    expect(parsed.hasSensitiveParams).toBe(false);
    expect(isRecoveryAuthLocation(loc)).toBe(false);
  });
});

describe("Auth routes, server recovery helper, and redirect guard wiring", () => {
  it("Sign-In route delegates Forgot Password to server-side requestPasswordReset instead of window.location.origin", () => {
    const authSource = readSource("src/routes/auth.tsx");
    expect(authSource).not.toContain("window.location.origin");
    expect(authSource).not.toContain("resetPasswordForEmail");
    expect(authSource).toContain("requestPasswordReset");
    expect(authSource).toContain("isRecoveryAuthLocation");
    expect(authSource).toContain("PASSWORD_RECOVERY");
  });

  it("Index and Root routes intercept recovery links/events so they never silently land on dashboard", () => {
    const indexSource = readSource("src/routes/index.tsx");
    const rootSource = readSource("src/routes/__root.tsx");
    expect(indexSource).toContain("isRecoveryAuthLocation");
    expect(indexSource).toContain("/auth/reset-password");
    expect(rootSource).toContain("PASSWORD_RECOVERY");
    expect(rootSource).toContain("/auth/reset-password");
  });

  it("Reset password route avoids duplicate verification, scrubs URL params, updates password, and links back to /auth", () => {
    const resetSource = readSource("src/routes/auth_.reset-password.tsx");
    expect(resetSource).toContain("useRef");
    expect(resetSource).toContain("verificationKeyRef");
    expect(resetSource).toContain("window.history.replaceState");
    expect(resetSource).toContain("buildSanitizedAuthPath");
    expect(resetSource).toContain("supabase.auth.updateUser({ password })");
    expect(resetSource).toContain("finalizePasswordRecovery");
    expect(resetSource).toContain('Link to={isSetupLink ? "/dashboard" : "/auth"}');
    expect(resetSource).toContain("Sign in to HRM");
  });

  it("Auth callback route enforces single-flight verification and strips sensitive parameters", () => {
    const callbackSource = readSource("src/routes/auth_.callback.tsx");
    expect(callbackSource).toContain("useRef");
    expect(callbackSource).toContain("startedRef");
    expect(callbackSource).toContain("buildSanitizedAuthPath");
    expect(callbackSource).toContain("parseAuthRecoveryLocation");
  });

  it("All server-side Auth email flows resolve redirects through centralized canonical URL helpers", () => {
    const workforceSource = readSource("src/lib/workforce.functions.ts");
    const invitationsSource = readSource("src/lib/invitations.server.ts");
    const recoveryServerSource = readSource("src/lib/auth-recovery.functions.ts");
    expect(workforceSource).toContain('resolveSupabaseAuthRedirectUrl("/auth/reset-password")');
    expect(invitationsSource).toContain('resolveSupabaseAuthRedirectUrl("/auth/callback")');
    expect(recoveryServerSource).toContain("resolvePasswordResetRedirectUrl");
    expect(recoveryServerSource).not.toMatch(/https?:\/\/(?:localhost|127\.0\.0\.1)/i);
  });
});
