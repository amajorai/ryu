// packages/services-cli/src/output.ts
//
// How `ryu-services` prints results and errors, and its exit codes.
// Human mode writes data to stdout and errors to stderr. `--json` writes one
// JSON document to stdout either way: `{ data, meta }` on success (the same
// shape the MCP tools return) or `{ error }` with `RyuError.toJSON()`, which
// never contains keys.

import {
	messageWithHint,
	messageWithoutHint,
	type RyuError,
	type RyuResponseMeta,
} from "@ryuhq/services";
import { cliHintFor, cliMessageFor } from "./hints.ts";
import { withProgram } from "./program.ts";
import type { CliWriter } from "./registry.ts";

/** Process exit codes (design §10). */
export const EXIT_CODES = {
	/** The command succeeded. */
	ok: 0,
	/** A service call failed with RyuError. */
	error: 1,
	/** The command line or the configuration is wrong. */
	usage: 2,
	/** `webhooks verify` rejected the delivery. */
	webhookVerification: 4,
} as const;

/** One of {@link EXIT_CODES}. */
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** JSON.stringify that survives bigint and Date values from service clients. */
export function toJson(value: unknown, indent?: number): string {
	return JSON.stringify(
		value,
		(_key, item: unknown) =>
			typeof item === "bigint" ? item.toString() : item,
		indent
	);
}

/** Writes `text` followed by a newline. */
export function writeLine(writer: CliWriter, text: string): void {
	writer.write(text.endsWith("\n") ? text : `${text}\n`);
}

/** Human rendering of a result: strings as they are, everything else as indented JSON. */
export function formatHuman(data: unknown): string {
	if (data === undefined || data === null) {
		return "OK";
	}
	if (typeof data === "string") {
		return data;
	}
	return toJson(data, 2) ?? String(data);
}

/** Prints a successful result. */
export function printSuccess(
	stdout: CliWriter,
	json: boolean,
	data: unknown,
	meta: RyuResponseMeta | null
): void {
	writeLine(
		stdout,
		json ? toJson({ data: data ?? null, meta }) : formatHuman(data)
	);
}

/** Prints one item of a streamed result (one JSON line per item in both modes). */
export function printStreamItem(stdout: CliWriter, item: unknown): void {
	writeLine(stdout, toJson(item) ?? "null");
}

/**
 * The human lines for a RyuError: code and message, then status, request id,
 * the Retry-After delay and hint when known. The hint gets its own line, so the message is printed without
 * the ` Hint: ...` suffix the SDK appends to it.
 */
export function formatError(error: RyuError): string {
	const lines = [`error ${error.code}: ${cliMessageFor(error)}`];
	if (error.status > 0) {
		lines.push(`  status: ${error.status}`);
	}
	if (error.requestId) {
		lines.push(`  requestId: ${error.requestId}`);
	}
	if (error.retryAfterSeconds !== null && error.retryAfterSeconds >= 0) {
		lines.push(`  retryAfter: ${error.retryAfterSeconds}s`);
	}
	const override = cliHintFor(error);
	const hint = override?.hint ?? error.hint;
	const docs = override?.docs ?? error.docs;
	if (hint) {
		lines.push(`  hint: ${hint}`);
	}
	if (docs) {
		lines.push(`  docs: ${docs}`);
	}
	return lines.join("\n");
}

/**
 * `error.toJSON()` with the CLI hint (see hints.ts) in place of the SDK's,
 * when there is one, and a configuration error's message in CLI words;
 * `message` then ends with the CLI hint too.
 */
export function errorJson(error: RyuError): ReturnType<RyuError["toJSON"]> {
	const json = error.toJSON();
	const override = cliHintFor(error);
	const message = cliMessageFor(error);
	if (override === null) {
		return message === messageWithoutHint(error)
			? json
			: { ...json, message: messageWithHint(message, error.hint) };
	}
	return {
		...json,
		message: messageWithHint(message, override.hint),
		hint: override.hint,
		...(override.docs === undefined ? {} : { docs: override.docs }),
	};
}

/**
 * Where errors print. `program` is the command line that runs this CLI
 * (`ryu-cli services` when a host delegates); the messages and hints name
 * it in place of `ryu-services` (see `withProgram`).
 */
export interface ErrorIo {
	readonly program?: string;
	readonly stderr: CliWriter;
	readonly stdout: CliWriter;
}

/** Prints a RyuError: `{ error }` JSON on stdout under `--json`, human lines on stderr otherwise. */
export function printError(io: ErrorIo, json: boolean, error: RyuError): void {
	if (json) {
		const body = errorJson(error);
		writeLine(
			io.stdout,
			toJson({
				error: {
					...body,
					message: withProgram(body.message, io.program),
					...(body.hint ? { hint: withProgram(body.hint, io.program) } : {}),
				},
			})
		);
		return;
	}
	writeLine(io.stderr, withProgram(formatError(error), io.program));
}

/** Prints a usage problem to stderr (and as `{ error }` JSON under `--json`). */
export function printUsageError(
	io: ErrorIo,
	json: boolean,
	usageMessage: string,
	usageHint = "Run ryu-services --help for usage."
): void {
	const message = withProgram(usageMessage, io.program);
	const hint = withProgram(usageHint, io.program);
	if (json) {
		writeLine(
			io.stdout,
			toJson({ error: { code: "usage_error", message, hint } })
		);
		return;
	}
	writeLine(io.stderr, `error usage_error: ${message}\n  hint: ${hint}`);
}
