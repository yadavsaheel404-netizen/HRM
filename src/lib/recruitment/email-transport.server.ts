// Server-only Email Delivery Transport (Hostinger SMTP via Nodemailer).
// NEVER import this module from client components — only inside server functions.

import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import {
  assertNoNonPublicLinks,
  buildPortalLink,
  resolveEmailPortalUrlFromEnv,
} from "../app-url";

const BRAND_LOGO_CID = "the-ai-school-logo@theaischool.co";
const BRAND_LOGO_URL_RE = /(?:https?:\/\/[^"'\s)]+)?\/the-ai-school-logo\.png/gi;

/**
 * Hydrates server environment variables from `.env` on disk when the running
 * SSR dev server process hasn't loaded non-`VITE_` keys (or was already running
 * before `.env` was edited). Production/Vercel process.env values always win,
 * and automated Vitest runs are left untouched so tests remain isolated.
 */
export function getRuntimeServerEnv(): Record<string, string | undefined> {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  const isVitest = baseEnv["VITEST"] === "true" || baseEnv["NODE_ENV"] === "test";
  if (isVitest) {
    return baseEnv;
  }

  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) {
      return baseEnv;
    }
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!String(baseEnv[key] ?? "").trim() && val) {
        baseEnv[key] = val;
      }
    }
  } catch {
    // Keep base process.env if `.env` is inaccessible
  }

  return baseEnv;
}

export type EmailDeliveryStatus =
  | "draft"
  | "queued"
  | "sending"
  | "accepted_by_smtp"
  | "sent"
  | "delivered"
  | "failed"
  | "canceled";

export type EmailProviderId = "hostinger_smtp";

export const SMTP_BULK_MAX_RECIPIENTS = 50;
export const SMTP_BULK_PACING_MS = 1200;
export const SMTP_MAX_RETRY_ATTEMPTS = 3;

export type EmailProviderStatusReport = {
  configured: boolean;
  provider: EmailProviderId;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  senderEmail: string | null;
  senderName: string;
  senderDisplay: string | null;
  replyTo: string | null;
  connectionTimeoutMs: number;
  sendTimeoutMs: number;
  issues: string[];
};

const SINGLE_EMAIL_RE =
  /^[^\s@<>(),;:\\"[\]]+@[^\s@<>(),;:\\"[\]]+\.[^\s@<>(),;:\\"[\]]{2,}$/i;
const EMAIL_EXTRACTOR_RE = /(?:^|<)\s*([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)\s*(?:>|$)/;
const CONTROL_CHARS_RE = /[\r\n\0]/;

const FORBIDDEN_CLIENT_PREFIX_KEYS = [
  "VITE_SMTP_HOST",
  "VITE_SMTP_PORT",
  "VITE_SMTP_SECURE",
  "VITE_SMTP_USER",
  "VITE_SMTP_PASS",
  "VITE_EMAIL_FROM",
  "VITE_IMAP_PASS",
] as const;

const PLACEHOLDER_VALUE_RE =
  /^<[^@>]+>$|<[^@>]*(?:your|secret|configured|placeholder|changeme)[^@>]*>|placeholder|changeme|your-smtp|your-password|example\.com/i;

export function containsHeaderInjection(value: string): boolean {
  return CONTROL_CHARS_RE.test(value);
}

export function sanitizeEmailHeaderValue(value: string): string {
  return value.replace(/[\r\n\0]+/g, " ").trim();
}

export function extractEmailAddress(raw: string): string | null {
  const cleaned = raw.trim();
  if (!cleaned || containsHeaderInjection(cleaned)) {
    return null;
  }
  const match = cleaned.match(EMAIL_EXTRACTOR_RE);
  if (!match?.[1]) {
    return null;
  }
  const normalized = match[1].trim().toLowerCase();
  return SINGLE_EMAIL_RE.test(normalized) ? normalized : null;
}

export function validateRecipientEmail(email: string): {
  valid: boolean;
  normalized: string;
  reason?: string;
} {
  if (typeof email !== "string") {
    return { valid: false, normalized: "", reason: "Recipient email is missing." };
  }
  if (containsHeaderInjection(email)) {
    return {
      valid: false,
      normalized: "",
      reason: "Recipient email contains invalid control characters.",
    };
  }
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) {
    return { valid: false, normalized: "", reason: "Recipient email is required." };
  }
  if (/[<>(),;\s]/.test(trimmed) || !SINGLE_EMAIL_RE.test(trimmed)) {
    return {
      valid: false,
      normalized: "",
      reason: "Enter a single valid recipient email address.",
    };
  }
  if (/^<.*>$/.test(trimmed)) {
    return {
      valid: false,
      normalized: "",
      reason: "Recipient email contains a placeholder.",
    };
  }
  return { valid: true, normalized: trimmed };
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  min = 1000,
  max = 120000,
): number {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * Resolves and validates Supabase Auth callback / recovery redirect URLs
 * without leaking internal origins or allowing unsafe schemes.
 */
export function resolveSupabaseAuthRedirectUrl(
  path: "/auth/reset-password" | "/auth/callback",
  env: Record<string, string | undefined> = getRuntimeServerEnv(),
): string {
  // Every server-generated auth redirect ends up inside an email, so it uses the
  // same strict canonical-URL rules (HTTPS, public host, no header derivation).
  return buildPortalLink(resolveEmailPortalUrlFromEnv(env), path);
}

/** Canonical HTTPS portal origin for outbound email; throws if misconfigured. */
export function resolveEmailPortalUrl(
  env: Record<string, string | undefined> = getRuntimeServerEnv(),
): string {
  return resolveEmailPortalUrlFromEnv(env);
}

/**
 * Inspects Hostinger SMTP server environment variables safely WITHOUT
 * ever returning, serializing, or logging `SMTP_PASS`.
 */
export function inspectEmailProviderConfig(
  env: Record<string, string | undefined> = getRuntimeServerEnv(),
): EmailProviderStatusReport {
  const issues: string[] = [];

  for (const key of FORBIDDEN_CLIENT_PREFIX_KEYS) {
    if (String(env[key] ?? "").trim()) {
      issues.push(
        `Insecure environment variable ${key} detected: SMTP settings must never use a VITE_ prefix.`,
      );
    }
  }

  const rawHost = String(env["SMTP_HOST"] ?? "").trim();
  const rawPort = String(env["SMTP_PORT"] ?? "").trim();
  const rawSecure = String(env["SMTP_SECURE"] ?? "").trim().toLowerCase();
  const rawUser = String(env["SMTP_USER"] ?? "").trim();
  const rawPass = String(env["SMTP_PASS"] ?? "").trim();
  const rawFrom = String(env["EMAIL_FROM"] ?? "").trim();
  const rawFromName =
    sanitizeEmailHeaderValue(String(env["EMAIL_FROM_NAME"] ?? "").trim()) ||
    "The AI School HR";
  const rawReplyTo = String(env["EMAIL_REPLY_TO"] ?? "").trim();

  const connectionTimeoutMs = parsePositiveInt(
    env["SMTP_CONNECTION_TIMEOUT_MS"],
    15000,
  );
  const sendTimeoutMs = parsePositiveInt(env["SMTP_SEND_TIMEOUT_MS"], 30000);

  let smtpHost: string | null = null;
  if (!rawHost) {
    issues.push("SMTP_HOST is not set (expected smtp.hostinger.com).");
  } else if (containsHeaderInjection(rawHost) || PLACEHOLDER_VALUE_RE.test(rawHost)) {
    issues.push("SMTP_HOST contains an invalid or placeholder value.");
  } else if (/titan\.email|resend\.(com|dev)/i.test(rawHost)) {
    issues.push(
      "SMTP_HOST points to a disallowed provider (Titan or Resend). Configure Hostinger SMTP (smtp.hostinger.com).",
    );
  } else {
    smtpHost = rawHost.toLowerCase();
  }

  let smtpPort: number | null = null;
  if (!rawPort) {
    issues.push("SMTP_PORT is not set (use 465 for SSL/TLS or 587 for STARTTLS).");
  } else {
    const parsedPort = Number(rawPort);
    if (parsedPort !== 465 && parsedPort !== 587) {
      issues.push("SMTP_PORT must be 465 (SSL/TLS) or 587 (STARTTLS) for Hostinger SMTP.");
    } else {
      smtpPort = parsedPort;
    }
  }

  let smtpSecure = false;
  if (rawSecure !== "true" && rawSecure !== "false") {
    issues.push("SMTP_SECURE must be explicitly set to 'true' (port 465) or 'false' (port 587).");
  } else {
    smtpSecure = rawSecure === "true";
    if (smtpPort === 465 && !smtpSecure) {
      issues.push("SMTP_SECURE must be 'true' when using Hostinger SMTPS port 465.");
    } else if (smtpPort === 587 && smtpSecure) {
      issues.push("SMTP_SECURE must be 'false' when using Hostinger STARTTLS port 587.");
    }
  }

  let smtpUserEmail: string | null = null;
  if (!rawUser) {
    issues.push("SMTP_USER is not set (expected hr@theaischool.co).");
  } else {
    const extracted = extractEmailAddress(rawUser);
    if (!extracted || PLACEHOLDER_VALUE_RE.test(rawUser)) {
      issues.push("SMTP_USER must be a valid Hostinger mailbox address (hr@theaischool.co).");
    } else if (/@gmail\.com$/i.test(extracted)) {
      issues.push(
        "SMTP_USER cannot be a personal Gmail account; configure the authorized Hostinger mailbox (hr@theaischool.co).",
      );
    } else {
      smtpUserEmail = extracted;
    }
  }

  if (!rawPass) {
    issues.push("SMTP_PASS is not set in server environment variables.");
  } else if (PLACEHOLDER_VALUE_RE.test(rawPass) || /^secret$/i.test(rawPass)) {
    issues.push("SMTP_PASS still contains a placeholder value.");
  }

  let senderEmail: string | null = null;
  let senderDisplay: string | null = null;
  if (!rawFrom) {
    issues.push("EMAIL_FROM is not set (expected hr@theaischool.co).");
  } else {
    const extractedFrom = extractEmailAddress(rawFrom);
    if (!extractedFrom || PLACEHOLDER_VALUE_RE.test(rawFrom)) {
      issues.push("EMAIL_FROM must be a valid sender email address (hr@theaischool.co).");
    } else if (/@resend\.dev$/i.test(extractedFrom) || /@gmail\.com$/i.test(extractedFrom)) {
      issues.push(
        "EMAIL_FROM must use the verified organization mailbox (hr@theaischool.co), not @resend.dev or @gmail.com.",
      );
    } else if (smtpUserEmail && extractedFrom !== smtpUserEmail) {
      issues.push(
        `EMAIL_FROM (${extractedFrom}) must match SMTP_USER (${smtpUserEmail}) for Hostinger sender alignment.`,
      );
    } else {
      senderEmail = extractedFrom;
      senderDisplay = `${rawFromName} <${extractedFrom}>`;
    }
  }

  let replyTo: string | null = senderEmail;
  if (rawReplyTo) {
    const extractedReplyTo = extractEmailAddress(rawReplyTo);
    if (!extractedReplyTo) {
      issues.push("EMAIL_REPLY_TO must be a valid email address without control characters.");
    } else {
      replyTo = extractedReplyTo;
    }
  }

  return {
    configured: issues.length === 0,
    provider: "hostinger_smtp",
    smtpHost,
    smtpPort,
    smtpSecure,
    senderEmail,
    senderName: rawFromName,
    senderDisplay,
    replyTo,
    connectionTimeoutMs,
    sendTimeoutMs,
    issues,
  };
}

export type SendEmailPayload = {
  to: string;
  subject: string;
  html: string;
  text?: string | undefined;
  replyTo?: string | undefined;
  idempotencyKey: string;
  attachments?: Mail.Attachment[] | undefined;
};

export type SendEmailTransportResult =
  | {
      ok: true;
      /**
       * Honest status rule: synchronous SMTP 250 acceptance ONLY confirms the relay
       * accepted the message (`accepted_by_smtp`), NEVER that the recipient inbox
       * received it (`delivered`).
       */
      status: "accepted_by_smtp";
      provider: EmailProviderId;
      providerMessageId: string;
      smtpResponse: string;
      attemptsUsed: number;
    }
  | {
      ok: false;
      status: "failed";
      provider: EmailProviderId;
      errorMessage: string;
      attemptsUsed: number;
    };

export interface EmailTransport {
  send(payload: SendEmailPayload): Promise<SendEmailTransportResult>;
}

export interface SmtpTransporterLike {
  sendMail(mailOptions: Mail.Options): Promise<{
    messageId?: string;
    response?: string;
    accepted?: unknown[];
    rejected?: unknown[];
  }>;
  verify?(): Promise<boolean | void>;
  close?(): void;
}

export type HostingerTransportOptions = {
  env?: Record<string, string | undefined> | undefined;
  transporterFactory?: ((config: EmailProviderStatusReport, pass: string) => SmtpTransporterLike) | undefined;
  allowInTests?: boolean | undefined;
  maxRetries?: number | undefined;
  retryBaseDelayMs?: number | undefined;
};

function createNodemailerTransporter(
  config: EmailProviderStatusReport,
  pass: string,
): SmtpTransporterLike {
  return nodemailer.createTransport({
    host: config.smtpHost!,
    port: config.smtpPort!,
    secure: config.smtpSecure,
    // Force STARTTLS upgrade when using port 587 (smtpSecure = false)
    requireTLS: !config.smtpSecure,
    auth: {
      user: config.senderEmail!,
      pass,
    },
    connectionTimeout: config.connectionTimeoutMs,
    greetingTimeout: config.connectionTimeoutMs,
    socketTimeout: config.sendTimeoutMs,
    // Always enforce strict TLS certificate verification
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
  });
}

function getErrorFields(error: unknown): {
  code: string;
  responseCode: number | null;
  message: string;
  response: string;
} {
  if (error == null || typeof error !== "object") {
    return {
      code: "",
      responseCode: null,
      message: String(error ?? "Unknown SMTP error"),
      response: "",
    };
  }
  const e = error as {
    code?: unknown;
    responseCode?: unknown;
    message?: unknown;
    response?: unknown;
  };
  return {
    code: typeof e.code === "string" ? e.code.toUpperCase() : "",
    responseCode: typeof e.responseCode === "number" ? e.responseCode : null,
    message: typeof e.message === "string" ? e.message : "Unknown SMTP error",
    response: typeof e.response === "string" ? e.response : "",
  };
}

export function isTransientSmtpError(error: unknown): boolean {
  const { code, responseCode, message } = getErrorFields(error);
  const lower = message.toLowerCase();

  if (code === "EAUTH" || responseCode === 535) return false;
  if (
    /self-signed|unable to verify|certificate|altnames|wrong version number/i.test(
      lower,
    ) ||
    code.startsWith("ERR_TLS")
  ) {
    return false;
  }
  if (responseCode !== null && responseCode >= 500 && responseCode < 600) {
    return false;
  }
  if (responseCode !== null && responseCode >= 400 && responseCode < 500) {
    return true;
  }
  if (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN" ||
    code === "ESOCKET"
  ) {
    return true;
  }
  return /timed?\s*out|rate\s*limit|try again|temporarily unavailable/i.test(lower);
}

export function computeSmtpRetryBackoffMs(
  attempt: number,
  baseDelayMs = 1000,
): number {
  if (baseDelayMs <= 0) return 0;
  return Math.min(baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)), 15000);
}

export function sanitizeSmtpResponse(rawResponse: string | undefined): string {
  if (!rawResponse) return "250 Accepted by SMTP relay";
  return sanitizeEmailHeaderValue(rawResponse).slice(0, 240);
}

export function sanitizeSmtpErrorMessage(
  error: unknown,
  secretToRedact?: string,
): string {
  const { code, responseCode, message, response } = getErrorFields(error);
  const combined = `${message} ${response}`.toLowerCase();

  let friendly: string;
  if (code === "EAUTH" || responseCode === 535 || combined.includes("authentication failed")) {
    friendly =
      "Hostinger SMTP authentication failed (535). Verify SMTP_USER and SMTP_PASS in server environment variables.";
  } else if (
    combined.includes("self-signed") ||
    combined.includes("certificate") ||
    combined.includes("unable to verify") ||
    code.startsWith("ERR_TLS")
  ) {
    friendly =
      "Hostinger SMTP TLS certificate verification failed. Ensure SMTP_HOST=smtp.hostinger.com and port/SSL settings match Hostinger.";
  } else if (code === "ETIMEDOUT" || combined.includes("timed out") || combined.includes("timeout")) {
    friendly =
      "Hostinger SMTP connection timed out. Check network reachability to smtp.hostinger.com.";
  } else if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    friendly =
      "Could not connect to Hostinger SMTP server. Check SMTP_HOST and SMTP_PORT settings.";
  } else if (responseCode === 550 || responseCode === 553 || responseCode === 554) {
    friendly = `SMTP server rejected recipient or message (${responseCode}).`;
  } else if (responseCode === 421 || responseCode === 450 || responseCode === 451 || responseCode === 452) {
    friendly = `SMTP server temporarily rate-limited or deferred the message (${responseCode}). Retry shortly.`;
  } else {
    friendly = sanitizeEmailHeaderValue(message || "SMTP delivery failed.").slice(0, 240);
  }

  if (secretToRedact && secretToRedact.length >= 4) {
    friendly = friendly.split(secretToRedact).join("[REDACTED]");
  }
  return friendly.replace(/password[=:]\s*\S+/gi, "password=[REDACTED]");
}

/**
 * Verifies Hostinger SMTP connectivity and credentials with strict TLS enabled,
 * without sending any email and without returning credentials.
 */
export async function verifySmtpConnection(
  options?: HostingerTransportOptions,
): Promise<{
  ok: boolean;
  provider: EmailProviderId;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  senderDisplay: string | null;
  message: string;
}> {
  const env = options?.env ?? getRuntimeServerEnv();
  const config = inspectEmailProviderConfig(env);

  if (!config.configured || !config.senderDisplay || !config.smtpHost || !config.smtpPort) {
    return {
      ok: false,
      provider: "hostinger_smtp",
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpSecure: config.smtpSecure,
      senderDisplay: config.senderDisplay,
      message: `SMTP configuration incomplete: ${config.issues.join(" ")}`,
    };
  }

  const isTestEnv =
    env["VITEST"] === "true" ||
    env["NODE_ENV"] === "test" ||
    process.env["VITEST"] === "true";

  if (isTestEnv && !options?.allowInTests) {
    return {
      ok: false,
      provider: "hostinger_smtp",
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpSecure: config.smtpSecure,
      senderDisplay: config.senderDisplay,
      message: "Live SMTP verification skipped inside automated test environment.",
    };
  }

  const smtpPass = String(env["SMTP_PASS"] ?? "").trim();
  const factory = options?.transporterFactory ?? createNodemailerTransporter;
  const transporter = factory(config, smtpPass);

  try {
    if (transporter.verify) {
      await transporter.verify();
    }
    return {
      ok: true,
      provider: "hostinger_smtp",
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpSecure: config.smtpSecure,
      senderDisplay: config.senderDisplay,
      message: `Connected & authenticated to Hostinger SMTP (${config.smtpHost}:${config.smtpPort}, ${config.smtpSecure ? "SSL/TLS" : "STARTTLS"}).`,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "hostinger_smtp",
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpSecure: config.smtpSecure,
      senderDisplay: config.senderDisplay,
      message: sanitizeSmtpErrorMessage(error, smtpPass),
    };
  } finally {
    transporter.close?.();
  }
}

export function createHostingerSmtpTransport(
  options?: HostingerTransportOptions,
): EmailTransport {
  const env = options?.env ?? getRuntimeServerEnv();

  return {
    async send(payload: SendEmailPayload): Promise<SendEmailTransportResult> {
      const isTestEnv =
        env["VITEST"] === "true" ||
        env["NODE_ENV"] === "test" ||
        process.env["VITEST"] === "true";

      if (isTestEnv && !options?.allowInTests) {
        return {
          ok: false,
          status: "failed",
          provider: "hostinger_smtp",
          errorMessage:
            "Blocked in automated test environment: live emails are never dispatched during tests.",
          attemptsUsed: 0,
        };
      }

      const recipientCheck = validateRecipientEmail(payload.to);
      if (!recipientCheck.valid) {
        return {
          ok: false,
          status: "failed",
          provider: "hostinger_smtp",
          errorMessage: recipientCheck.reason || "Invalid recipient email address.",
          attemptsUsed: 0,
        };
      }

      if (containsHeaderInjection(payload.subject)) {
        return {
          ok: false,
          status: "failed",
          provider: "hostinger_smtp",
          errorMessage: "Email subject rejected: contains unsafe header characters.",
          attemptsUsed: 0,
        };
      }

      // Last line of defence for EVERY sender (setup, KYC, Email Center, custom
      // templates): never deliver localhost / loopback / private-network links.
      try {
        assertNoNonPublicLinks(`${payload.html ?? ""}\n${payload.text ?? ""}`);
      } catch (error) {
        return {
          ok: false,
          status: "failed",
          provider: "hostinger_smtp",
          errorMessage: error instanceof Error ? error.message : "Email contains a non-public link.",
          attemptsUsed: 0,
        };
      }

      const config = inspectEmailProviderConfig(env);
      if (!config.configured || !config.senderDisplay || !config.senderEmail) {
        return {
          ok: false,
          status: "failed",
          provider: "hostinger_smtp",
          errorMessage: `Hostinger SMTP is not configured: ${config.issues.join(" ")}`,
          attemptsUsed: 0,
        };
      }

      let resolvedReplyTo: string | undefined = config.replyTo ?? config.senderEmail;
      if (payload.replyTo) {
        const replyCheck = validateRecipientEmail(payload.replyTo);
        if (!replyCheck.valid) {
          return {
            ok: false,
            status: "failed",
            provider: "hostinger_smtp",
            errorMessage: "Reply-To address is invalid or contains unsafe characters.",
            attemptsUsed: 0,
          };
        }
        resolvedReplyTo = replyCheck.normalized;
      }

      const smtpPass = String(env["SMTP_PASS"] ?? "").trim();
      const factory = options?.transporterFactory ?? createNodemailerTransporter;
      const transporter = factory(config, smtpPass);

      const maxRetries = Math.max(0, options?.maxRetries ?? SMTP_MAX_RETRY_ATTEMPTS - 1);
      const baseDelayMs = options?.retryBaseDelayMs ?? 1000;
      const cleanSubject = sanitizeEmailHeaderValue(payload.subject);

      let outgoingHtml = payload.html;
      let inlineAttachments: Mail.Attachment[] | undefined;
      if (!options?.transporterFactory && /the-ai-school-logo\.png/i.test(payload.html)) {
        const logoDiskPath = path.resolve(process.cwd(), "public", "the-ai-school-logo.png");
        if (fs.existsSync(logoDiskPath)) {
          outgoingHtml = payload.html.replace(BRAND_LOGO_URL_RE, `cid:${BRAND_LOGO_CID}`);
          inlineAttachments = [
            {
              filename: "the-ai-school-logo.png",
              path: logoDiskPath,
              cid: BRAND_LOGO_CID,
              contentDisposition: "inline",
            },
          ];
        }
      }

      let lastErrorMessage = "SMTP delivery failed.";
      let attemptsUsed = 0;

      try {
        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
          attemptsUsed = attempt;
          try {
            const combinedAttachments = [
              ...(inlineAttachments ?? []),
              ...(payload.attachments ?? []),
            ];
            const info = await transporter.sendMail({
              from: config.senderDisplay,
              to: recipientCheck.normalized,
              ...(resolvedReplyTo ? { replyTo: resolvedReplyTo } : {}),
              subject: cleanSubject,
              html: outgoingHtml,
              ...(payload.text ? { text: payload.text } : {}),
              ...(combinedAttachments.length > 0 ? { attachments: combinedAttachments } : {}),
              headers: {
                "X-Entity-Ref-ID": sanitizeEmailHeaderValue(payload.idempotencyKey).slice(0, 128),
              },
            });

            if (Array.isArray(info.rejected) && info.rejected.length > 0) {
              return {
                ok: false,
                status: "failed",
                provider: "hostinger_smtp",
                errorMessage: "SMTP server rejected recipient address.",
                attemptsUsed,
              };
            }

            // CRITICAL: SMTP 250 OK only confirms relay acceptance (`accepted_by_smtp`),
            // NEVER final recipient mailbox delivery (`delivered`).
            return {
              ok: true,
              status: "accepted_by_smtp",
              provider: "hostinger_smtp",
              providerMessageId: sanitizeEmailHeaderValue(
                String(info.messageId || `<${payload.idempotencyKey}@theaischool.co>`),
              ),
              smtpResponse: sanitizeSmtpResponse(info.response),
              attemptsUsed,
            };
          } catch (error) {
            lastErrorMessage = sanitizeSmtpErrorMessage(error, smtpPass);
            const canRetry = attempt <= maxRetries && isTransientSmtpError(error);
            if (!canRetry) {
              return {
                ok: false,
                status: "failed",
                provider: "hostinger_smtp",
                errorMessage: lastErrorMessage,
                attemptsUsed,
              };
            }
            const delayMs = computeSmtpRetryBackoffMs(attempt, baseDelayMs);
            if (delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
          }
        }
      } finally {
        transporter.close?.();
      }

      return {
        ok: false,
        status: "failed",
        provider: "hostinger_smtp",
        errorMessage: lastErrorMessage,
        attemptsUsed,
      };
    },
  };
}

/**
 * Backward-compatible alias retained temporarily for callers importing the legacy symbol;
 * dispatches exclusively through Hostinger SMTP (Resend has been removed).
 */
export const createResendEmailTransport = createHostingerSmtpTransport;

/**
 * Normalizes stored delivery statuses (preserving legacy `"sent"` records while
 * adopting `"accepted_by_smtp"` and `"canceled"` for Hostinger SMTP).
 */
export function resolveStatusFromProviderEvent(
  eventType: string,
): { status: "accepted_by_smtp" | "sent" | "delivered" | "failed" | "canceled"; errorMessage?: string } | null {
  switch (eventType) {
    case "smtp.accepted":
    case "email.accepted_by_smtp":
      return { status: "accepted_by_smtp" };
    case "email.sent":
      return { status: "sent" };
    case "email.delivered":
      return { status: "delivered" };
    case "email.bounced":
      return { status: "failed", errorMessage: "SMTP reported recipient bounce." };
    case "email.complained":
      return { status: "failed", errorMessage: "Recipient reported spam complaint." };
    case "email.canceled":
      return { status: "canceled" };
    default:
      return null;
  }
}
