// `ryu secrets import FILE --format doppler|envkey`: migrate from Doppler or
// EnvKey by reading their export file offline. Nothing here calls either
// service; the CLI turns the file into a name→value JSON object and sends it
// through Core's ordinary `json` import, so conflicts, policies and the audit
// log behave exactly as for any other import.
//
// - doppler: `doppler secrets download --no-file --format json` (a flat
//   `{"NAME": "value"}` object). Doppler adds `DOPPLER_PROJECT`,
//   `DOPPLER_CONFIG` and `DOPPLER_ENVIRONMENT`, which describe the source and
//   are dropped. The `doppler secrets --json` listing
//   (`{"NAME": {"computed": …, "raw": …}}`) is accepted too and imports the
//   computed value.
// - envkey: a flat `{"NAME": "value"}` JSON export of one environment.
//
// A dotenv export from either tool imports with `--format dotenv` instead.
// Errors name keys only, never a value.

import { tf } from "../i18n/translate.ts";
import { UsageError } from "./types.ts";

export const FOREIGN_IMPORT_FORMATS = ["doppler", "envkey"] as const;
export type ForeignImportFormat = (typeof FOREIGN_IMPORT_FORMATS)[number];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOPPLER_METADATA = new Set([
	"DOPPLER_PROJECT",
	"DOPPLER_CONFIG",
	"DOPPLER_ENVIRONMENT",
]);

export function isForeignImportFormat(
	value: string | undefined
): value is ForeignImportFormat {
	return (FOREIGN_IMPORT_FORMATS as readonly string[]).includes(value ?? "");
}

function notAnObject(file: string): string {
	return tf("{file} is not a JSON object of names and values.", { file });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: string, file: string): Record<string, unknown> {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new UsageError(notAnObject(file));
	}
	if (!isRecord(raw)) {
		throw new UsageError(notAnObject(file));
	}
	return raw;
}

/** A Doppler entry: a plain string, or the listing's `{computed, raw}`. */
function dopplerValue(entry: unknown): string | null {
	if (typeof entry === "string") {
		return entry;
	}
	if (isRecord(entry)) {
		if (typeof entry.computed === "string") {
			return entry.computed;
		}
		if (typeof entry.raw === "string") {
			return entry.raw;
		}
	}
	return null;
}

function envkeyValue(entry: unknown): string | null {
	return typeof entry === "string" ? entry : null;
}

/** The name→value map in a Doppler or EnvKey export file. */
export function parseForeignExport(
	format: ForeignImportFormat,
	text: string,
	file: string
): Record<string, string> {
	const raw = parseObject(text, file);
	const values: Record<string, string> = {};
	const invalid: string[] = [];
	for (const [name, entry] of Object.entries(raw)) {
		if (format === "doppler" && DOPPLER_METADATA.has(name)) {
			continue;
		}
		const value =
			format === "doppler" ? dopplerValue(entry) : envkeyValue(entry);
		if (value === null || !ENV_NAME.test(name)) {
			invalid.push(name);
			continue;
		}
		values[name] = value;
	}
	if (invalid.length > 0) {
		throw new UsageError(
			tf(
				"{file}: these entries are not a variable name with a text value: {names}.",
				{ file, names: invalid.join(", ") }
			)
		);
	}
	return values;
}

/** The `json` import content for a Doppler or EnvKey export file. */
export function foreignImportContent(
	format: ForeignImportFormat,
	text: string,
	file: string
): string {
	return JSON.stringify(parseForeignExport(format, text, file));
}
