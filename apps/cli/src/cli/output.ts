// Formatting helpers for the non-interactive `ryu` CLI: a minimal column table for
// human output and the typed-error renderers so a 409 (dependents / built-in /
// grants / gateway-down) or the control plane's second-factor refusal reads as a
// clear sentence, never a raw dump.

import {
	isMfaEnrollmentRequiredError,
	MFA_ENROLLMENT_REQUIRED_CODE,
} from "@ryuhq/core-client/mfa-enrollment";
import {
	type AppLifecycleError,
	dependencyErrorSchema,
} from "@ryuhq/core-client/plugins";
import { z } from "zod";
import {
	MFA_ENROLLMENT_SETUP_URL,
	mfaEnrollmentCommandMessage,
} from "../core/mfaEnrollment.ts";
import { accessRefusalHint } from "../core/native-errors.ts";
import { tr } from "../i18n/translate.ts";
import { localizedTextOf, renderLocalized } from "./localizedText.ts";

/** Terminal columns a cell occupies, so CJK and emoji cells keep alignment. */
function displayWidth(value: string): number {
	return Bun.stringWidth(value);
}

/** Render a header row + body rows as a left-aligned, space-padded table. */
export function formatTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) =>
		Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? "")))
	);
	const line = (cells: string[]): string =>
		cells
			.map((c, i) => {
				const cell = c ?? "";
				const pad = Math.max(0, (widths[i] ?? 0) - displayWidth(cell));
				return `${cell}${" ".repeat(pad)}`;
			})
			.join("  ")
			.trimEnd();
	return [line(headers), ...rows.map(line)].join("\n");
}

/** Truncate a string to `max` chars with an ellipsis, for table cells. */
export function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const nativeErrorSchema = z.instanceof(Error);
const lifecycleDetailsSchema = z.object({
	dependencyError: dependencyErrorSchema.nullable().catch(null),
	gatewayUnreachable: z.boolean().catch(false),
	grantsDenied: z.boolean().catch(false),
	builtIn: z.boolean().catch(false),
	hint: z.string().nullable().catch(null),
});

/** Core attaches these markers to its native lifecycle errors. */
function hasLifecycleDetails(error: Error): boolean {
	return (
		"dependencyError" in error ||
		"gatewayUnreachable" in error ||
		"grantsDenied" in error ||
		"builtIn" in error
	);
}

/**
 * Parse caught native errors before displaying Core's optional lifecycle hint.
 * Human output only: an error built with `localize` renders its whole sentence
 * in the CLI locale, a message that is known UI copy (a static `Error`/
 * `UsageError` sentence the extractor collected) is looked up in the catalog,
 * and anything else, such as a server's own text, stays as sent. `--json` uses
 * {@link errorToJson}, which keeps the English `message`.
 */
export function formatError(
	error: Parameters<typeof nativeErrorSchema.safeParse>[0]
): string {
	const parsed = nativeErrorSchema.safeParse(error);
	if (!parsed.success) {
		return String(error);
	}
	if (isMfaEnrollmentRequiredError(parsed.data)) {
		return tr(mfaEnrollmentCommandMessage());
	}
	const refusal = accessRefusalHint(parsed.data);
	if (refusal) {
		return tr(refusal.hint);
	}
	const localized = localizedTextOf(parsed.data);
	const message = localized
		? renderLocalized(localized)
		: tr(parsed.data.message);
	if (hasLifecycleDetails(parsed.data)) {
		const details = lifecycleDetailsSchema.parse(parsed.data);
		return details.hint ? `${message} (${tr(details.hint)})` : message;
	}
	return message;
}

interface CliErrorEnvelope {
	builtIn?: AppLifecycleError["builtIn"];
	/** Machine-readable reason, set for the second-factor and access refusals. */
	code?: string;
	dependencyError?: AppLifecycleError["dependencyError"];
	error: string;
	gatewayUnreachable?: AppLifecycleError["gatewayUnreachable"];
	grantsDenied?: AppLifecycleError["grantsDenied"];
	hint?: AppLifecycleError["hint"];
	/** The website page that resolves `code`. */
	setupUrl?: string;
}

/** A machine-readable envelope for a caught error under `--json`. */
export function errorToJson(
	error: Parameters<typeof nativeErrorSchema.safeParse>[0]
): CliErrorEnvelope {
	const parsed = nativeErrorSchema.safeParse(error);
	if (!parsed.success) {
		return { error: String(error) };
	}
	if (isMfaEnrollmentRequiredError(parsed.data)) {
		return {
			code: MFA_ENROLLMENT_REQUIRED_CODE,
			error: mfaEnrollmentCommandMessage(),
			setupUrl: MFA_ENROLLMENT_SETUP_URL,
		};
	}
	const refusal = accessRefusalHint(parsed.data);
	if (refusal) {
		return {
			code: refusal.code,
			error: parsed.data.message,
			hint: refusal.hint,
		};
	}
	if (hasLifecycleDetails(parsed.data)) {
		const details = lifecycleDetailsSchema.parse(parsed.data);
		return { error: parsed.data.message, ...details };
	}
	return { error: parsed.data.message };
}
