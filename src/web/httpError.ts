/**
 * CliExitCode → HTTP status code mapping + CliError → JSON response.
 *
 * Write endpoints delegate to CLI command paths; commands throw CliError (exitCode + user-facing message + debugMessage).
 * The endpoint layer maps exitCode to an HTTP status. The user-facing message goes to the frontend; debugMessage / stack only go to the backend log.
 */
import type { FastifyReply } from "fastify";

import { CliError, CliExitCode } from "../cli/index.js";

/**
 * Compile-time Record guarantees coverage of the full set except Sigint (same source as CliExitCode).
 * Sigint(130) is not on the web write path (the web layer never runs a host in the foreground) → explicitly Excluded.
 */
export const EXIT_TO_HTTP: Readonly<Record<Exclude<CliExitCode, typeof CliExitCode.Sigint>, number>> = {
  [CliExitCode.Ok]: 200,
  [CliExitCode.GeneralError]: 500,
  [CliExitCode.NotFound]: 404,
  [CliExitCode.IllegalState]: 409,
  [CliExitCode.InvalidArgument]: 400,
  [CliExitCode.IoError]: 500,
  [CliExitCode.SingleInstance]: 409,
};

/** CliError → HTTP status (unknown exitCode falls back to 500). */
export function httpStatusForCliError(err: CliError): number {
  if (err.exitCode === CliExitCode.Sigint) return 500;
  return EXIT_TO_HTTP[err.exitCode as Exclude<CliExitCode, typeof CliExitCode.Sigint>] ?? 500;
}

/**
 * Map any caught error to an HTTP response.
 * - CliError: map status by exitCode; message goes to the frontend; debugMessage / stack go to the backend log
 * - otherwise: 500 + generic text; stack goes to the log
 */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof CliError) {
    const status = httpStatusForCliError(err);
    reply.log.warn(
      { errorKind: err.errorKind, exitCode: err.exitCode, debugMessage: err.debugMessage },
      "web write action CliError",
    );
    void reply.code(status).send({ ok: false, message: err.message });
    return reply;
  }
  reply.log.error({ err }, "web endpoint unexpected error");
  void reply.code(500).send({ ok: false, message: "The operation could not be completed; please try again later" });
  return reply;
}
