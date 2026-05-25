/**
 * Web security contract: single-authority loopback check + two-layer request validation (defends against DNS rebinding + CSRF).
 *
 * No auth / no cookie / no session — security relies on two layers: bind strictly to loopback + reject cross-origin requests.
 * Bind-address validation and request Host / Origin checks share the same `isLoopbackHost`.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Single-authority loopback check. Accepts bare host / `host:port` / IPv6 bracket forms.
 * Passes: `localhost` / `127.0.0.0/8` / `::1` / `[::1]`.
 */
export function isLoopbackHost(host: string): boolean {
  if (host.length === 0) return false;
  let h = host.trim();
  // Strip IPv6 bracket + port: [::1]:3000 → ::1
  if (h.startsWith("[")) {
    const close = h.indexOf("]");
    if (close === -1) return false;
    h = h.slice(1, close);
  } else {
    // host:port (IPv4 / hostname); a bare IPv6 address has multiple colons and is not stripped here
    const colonCount = (h.match(/:/g) ?? []).length;
    if (colonCount === 1) h = h.slice(0, h.indexOf(":"));
  }
  h = h.toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  // IPv4 127.0.0.0/8
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m !== null) {
    const octets = m.slice(1, 5).map((s) => Number.parseInt(s, 10));
    if (octets.every((n) => n >= 0 && n <= 255) && octets[0] === 127) return true;
  }
  return false;
}

/** Bind-address validation (fail-fast): a non-loopback bind address → refuse to start. */
export function assertLoopbackBindHost(host: string): void {
  // For bind addresses, additionally reject 0.0.0.0 / :: (listening on all interfaces) — those are not loopback.
  const h = host.trim().toLowerCase();
  if (h === "0.0.0.0" || h === "::" || h === "[::]" || !isLoopbackHost(host)) {
    throw new Error(`web server refuses to bind non-loopback address: ${host} (loopback-only)`);
  }
}

/** Extract the host part from Origin / Referer; returns undefined on parse failure. */
function hostOfUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    return new URL(raw).host;
  } catch {
    return undefined;
  }
}

/**
 * Two-layer request validation. On failure, sends 403 and returns true (caller should abort).
 *
 * - Layer 1 (all /api/*, including read-only GET): the Host header must be loopback
 * - Layer 2 (state-changing methods + streaming connections): Origin / Referer host must be loopback; when both are
 *   absent, fall back to "layer 1 Host already covers it"
 */
export function rejectIfUnsafe(req: FastifyRequest, reply: FastifyReply, opts: { originCheck: boolean }): boolean {
  const hostHeader = typeof req.headers.host === "string" ? req.headers.host : "";
  if (!isLoopbackHost(hostHeader)) {
    void reply.code(403).send({ ok: false, message: "Request rejected (local access only)" });
    return true;
  }
  if (opts.originCheck) {
    const originHeader = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const refererHeader = typeof req.headers.referer === "string" ? req.headers.referer : undefined;
    const originHost = hostOfUrl(originHeader);
    const refererHost = hostOfUrl(refererHeader);
    if (originHost !== undefined) {
      if (!isLoopbackHost(originHost)) {
        void reply.code(403).send({ ok: false, message: "Request rejected (cross-origin requests are not allowed)" });
        return true;
      }
    } else if (refererHost !== undefined) {
      if (!isLoopbackHost(refererHost)) {
        void reply.code(403).send({ ok: false, message: "Request rejected (cross-origin requests are not allowed)" });
        return true;
      }
    }
    // Both absent: layer 1 Host already covers it (same-origin signal missing but local loopback) → allow
  }
  return false;
}

/** Set of state-changing methods (subject to the layer-2 Origin check). */
export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "DELETE", "PATCH"]);
