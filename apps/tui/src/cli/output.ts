// Formatting helpers for the non-interactive `ryu` CLI: a minimal column table for
// human output and the typed-lifecycle-error renderer so a 409 (dependents /
// built-in / grants / gateway-down) reads as a clear sentence, never a raw dump.

import type { AppLifecycleError } from "@ryuhq/core-client/plugins";

/** Render a header row + body rows as a left-aligned, space-padded table. */
export function formatTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
	);
	const line = (cells: string[]): string =>
		cells
			.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd();
	return [line(headers), ...rows.map(line)].join("\n");
}

/** Truncate a string to `max` chars with an ellipsis, for table cells. */
export function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The extra structured fields core-client attaches to a thrown lifecycle Error
 *  (`Object.assign(new Error(message), AppLifecycleError)`). */
type LifecycleErrorLike = Error & Partial<AppLifecycleError>;

/** True when a caught value carries the AppLifecycleError shape. */
function isLifecycleError(e: unknown): e is LifecycleErrorLike {
	return (
		e instanceof Error &&
		("dependencyError" in e ||
			"gatewayUnreachable" in e ||
			"grantsDenied" in e ||
			"builtIn" in e)
	);
}

/** A human-readable one-line message for a caught error. The lifecycle `.message`
 *  is already the actionable sentence (describeDependencyError / grants / gateway);
 *  we append Core's `hint` when present. */
export function formatError(e: unknown): string {
	if (isLifecycleError(e)) {
		return e.hint ? `${e.message} (${e.hint})` : e.message;
	}
	if (e instanceof Error) {
		return e.message;
	}
	return String(e);
}

/** A machine-readable object for a caught error under `--json`. */
export function errorToJson(e: unknown): Record<string, unknown> {
	if (isLifecycleError(e)) {
		return {
			error: e.message,
			dependencyError: e.dependencyError ?? null,
			gatewayUnreachable: e.gatewayUnreachable ?? false,
			grantsDenied: e.grantsDenied ?? false,
			builtIn: e.builtIn ?? false,
			hint: e.hint ?? null,
		};
	}
	return { error: e instanceof Error ? e.message : String(e) };
}
