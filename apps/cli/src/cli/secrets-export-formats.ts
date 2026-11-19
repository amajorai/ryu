// Export formats the CLI renders itself from Core's `json` export:
// `csv`, `toml`, `hcl` and `ini`. Core renders dotenv, json, yaml, shell and
// k8s; these four are layouts of the same name→value map, so they need no
// Core change and behave the same against older nodes.
//
// Quoting, per format:
// - csv: RFC 4180. A `name,value` header, CRLF line ends; a field holding a
//   comma, a double quote, CR or LF is double-quoted with `"` doubled.
// - toml: `NAME = "…"` basic strings with `\\`, `\"`, `\b`, `\t`, `\n`, `\f`,
//   `\r` and `\uXXXX` for other control characters.
// - hcl: `NAME = "…"` with `\\`, `\"`, `\n`, `\r`, `\t`, `\uXXXX` for other
//   control characters, and `${` / `%{` written as `$${` / `%%{` so a value is
//   never read as a template.
// - ini: one `[ENVIRONMENT]` section; every value double-quoted in the
//   git-config style (`\\`, `\"`, `\n`, `\r`, `\t`).
//
// Names are environment-variable shaped (Core enforces `[A-Za-z_][A-Za-z0-9_]*`),
// so they are written bare.

import {
	parseVaultJsonExport,
	type VaultExportResult,
} from "@ryuhq/core-client/vault";
import { flag, type SecretsArgs } from "./secrets-args.ts";

export const LOCAL_EXPORT_FORMATS = ["csv", "toml", "hcl", "ini"] as const;
export type LocalExportFormat = (typeof LOCAL_EXPORT_FORMATS)[number];

const CONTENT_TYPES: Record<LocalExportFormat, string> = {
	csv: "text/csv",
	toml: "application/toml",
	hcl: "text/plain",
	ini: "text/plain",
};

/** An export as printed: Core's result, or one re-rendered here. */
export type RenderedExport = Omit<
	VaultExportResult,
	"contentType" | "format"
> & {
	contentType: string;
	format: string;
};

export function isLocalExportFormat(
	value: string | undefined
): value is LocalExportFormat {
	return (LOCAL_EXPORT_FORMATS as readonly string[]).includes(value ?? "");
}

function hex4(char: string): string {
	return `\\u${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

const TOML_ESCAPES: Record<string, string> = {
	"\\": "\\\\",
	'"': '\\"',
	"\b": "\\b",
	"\t": "\\t",
	"\n": "\\n",
	"\f": "\\f",
	"\r": "\\r",
};

const QUOTED_ESCAPES: Record<string, string> = {
	"\\": "\\\\",
	'"': '\\"',
	"\t": "\\t",
	"\n": "\\n",
	"\r": "\\r",
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: escaping control characters is the point.
const CONTROL_OR_SPECIAL = /[\u0000-\u001f\u007f"\\]/g;

const TEMPLATE_START = /[$%]\{/g;

function escapeWith(value: string, table: Record<string, string>): string {
	return value.replace(CONTROL_OR_SPECIAL, (char) => table[char] ?? hex4(char));
}

export function csvField(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function tomlString(value: string): string {
	return `"${escapeWith(value, TOML_ESCAPES)}"`;
}

export function hclString(value: string): string {
	const escaped = escapeWith(value, QUOTED_ESCAPES)
		// A function replacement: in a replacement string `$$` is a single `$`.
		.replace(TEMPLATE_START, (match) => `${match[0]}${match}`);
	return `"${escaped}"`;
}

export function iniString(value: string): string {
	return `"${escapeWith(value, QUOTED_ESCAPES)}"`;
}

/** Render `values` (in order) as `format`. */
export function renderValues(
	format: LocalExportFormat,
	values: Record<string, string>,
	environment: string
): string {
	const entries = Object.entries(values);
	switch (format) {
		case "csv":
			return `${["name,value", ...entries.map(([name, value]) => `${csvField(name)},${csvField(value)}`)].join("\r\n")}\r\n`;
		case "toml":
			return entries
				.map(([name, value]) => `${name} = ${tomlString(value)}\n`)
				.join("");
		case "hcl":
			return entries
				.map(([name, value]) => `${name} = ${hclString(value)}\n`)
				.join("");
		case "ini":
			return `[${environment}]\n${entries.map(([name, value]) => `${name} = ${iniString(value)}\n`).join("")}`;
		default:
			return format satisfies never;
	}
}

/** Re-render a `json` export when `--format` names a CLI-rendered format;
 *  any other export is returned as Core rendered it. */
export function renderRequestedExport(
	args: SecretsArgs,
	result: VaultExportResult
): RenderedExport {
	const format = flag(args, "--format");
	if (!isLocalExportFormat(format)) {
		return result;
	}
	return {
		...result,
		format,
		contentType: CONTENT_TYPES[format],
		content: renderValues(
			format,
			parseVaultJsonExport(result),
			result.environment
		),
	};
}
