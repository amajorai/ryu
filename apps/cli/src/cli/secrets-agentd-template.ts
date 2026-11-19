// Templates for `ryu secrets agent`: the placeholder grammar and the renderer.
//
// A template is plain text with placeholders in the grammar the credential
// broker already uses for header templates (`{{secret:REF}}`), plus one form
// for dynamic credentials:
//
//   {{secret:REF}}           a vault value; REF is NAME, /folder/NAME,
//                            ENV:NAME or ENV:/folder/NAME
//   {{lease:NAME.FIELD}}     a field of the agent's lease NAME (config `leases`)
//   {{secret:REF | json}}    the value as a JSON string literal (quoted, escaped)
//   {{secret:REF | base64}}  the value base64-encoded
//   \{{                      a literal `{{`
//
// Spaces inside the braces are optional. Any other `{{` text is left as is, so
// a template can carry another tool's syntax. A placeholder that starts like
// one of ours but does not parse is an error at load time, so a typo never
// renders silently. Errors name references, never values.

import {
	parseVaultReference,
	type VaultReference,
} from "@ryuhq/core-client/vault";
import { tf } from "../i18n/translate.ts";

export type TemplateFilter = "raw" | "json" | "base64";

export type TemplatePart =
	| { kind: "text"; text: string }
	| {
			filter: TemplateFilter;
			kind: "secret";
			reference: VaultReference;
			source: string;
	  }
	| {
			field: string;
			filter: TemplateFilter;
			kind: "lease";
			lease: string;
			source: string;
	  };

export class TemplateError extends Error {}

const PLACEHOLDER = /\{\{\s*(secret|lease)\s*:([^}]*)\}\}/y;
const OPENER = /\{\{\s*(secret|lease)\s*:/y;
const LEASE_REF = /^([A-Za-z0-9_.-]+?)\.([A-Za-z0-9_-]+)$/;
const FILTERS = new Set<TemplateFilter>(["raw", "json", "base64"]);

function lineAt(text: string, index: number): number {
	let line = 1;
	for (let at = 0; at < index; at++) {
		if (text.charCodeAt(at) === 10) {
			line += 1;
		}
	}
	return line;
}

function invalid(file: string, text: string, index: number): TemplateError {
	return new TemplateError(
		tf("{file}:{line}: invalid placeholder.", {
			file,
			line: String(lineAt(text, index)),
		})
	);
}

function splitFilter(body: string): { filter: string; ref: string } {
	const bar = body.indexOf("|");
	if (bar === -1) {
		return { ref: body.trim(), filter: "raw" };
	}
	return { ref: body.slice(0, bar).trim(), filter: body.slice(bar + 1).trim() };
}

function placeholderPart(
	kind: string,
	body: string,
	source: string
): TemplatePart | null {
	const { ref, filter } = splitFilter(body);
	if (!FILTERS.has(filter as TemplateFilter)) {
		return null;
	}
	const typedFilter = filter as TemplateFilter;
	if (kind === "secret") {
		const reference = parseVaultReference(ref);
		return reference
			? { kind: "secret", reference, filter: typedFilter, source }
			: null;
	}
	const match = LEASE_REF.exec(ref);
	if (!(match?.[1] && match[2])) {
		return null;
	}
	return {
		kind: "lease",
		lease: match[1],
		field: match[2],
		filter: typedFilter,
		source,
	};
}

/** Parse a template into literal text and placeholders. `file` only names the
 *  template in errors. */
export function parseTemplate(text: string, file: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	let literal = "";
	let index = 0;
	while (index < text.length) {
		if (text.startsWith("\\{{", index)) {
			literal += "{{";
			index += 3;
			continue;
		}
		OPENER.lastIndex = index;
		if (!(text.startsWith("{{", index) && OPENER.test(text))) {
			literal += text[index];
			index += 1;
			continue;
		}
		PLACEHOLDER.lastIndex = index;
		const match = PLACEHOLDER.exec(text);
		const part = match
			? placeholderPart(
					match[1] ?? "",
					match[2] ?? "",
					`${match[1]}:${(match[2] ?? "").trim()}`
				)
			: null;
		if (!(match && part)) {
			throw invalid(file, text, index);
		}
		if (literal) {
			parts.push({ kind: "text", text: literal });
			literal = "";
		}
		parts.push(part);
		index += match[0].length;
	}
	if (literal) {
		parts.push({ kind: "text", text: literal });
	}
	return parts;
}

/** The (environment, path, name) a secret placeholder reads, with the
 *  config's defaults filled in. */
export interface ResolvedReference {
	environment: string | undefined;
	name: string;
	path: string;
}

export function resolveReference(
	reference: VaultReference,
	defaults: { environment?: string; path?: string }
): ResolvedReference {
	return {
		environment: reference.environment ?? defaults.environment,
		path: reference.path ?? defaults.path ?? "/",
		name: reference.name,
	};
}

/** A stable key for one resolved reference. */
export function referenceKey(reference: ResolvedReference): string {
	return `${reference.environment ?? ""}\u0000${reference.path}\u0000${reference.name}`;
}

/** Everything a render can read. */
export interface RenderInputs {
	defaults: { environment?: string; path?: string };
	leases: ReadonlyMap<string, Readonly<Record<string, string>>>;
	values: ReadonlyMap<string, string>;
}

function applyFilter(value: string, filter: TemplateFilter): string {
	if (filter === "json") {
		return JSON.stringify(value);
	}
	if (filter === "base64") {
		return Buffer.from(value, "utf8").toString("base64");
	}
	return value;
}

function lookup(part: TemplatePart, inputs: RenderInputs): string | undefined {
	if (part.kind === "secret") {
		return inputs.values.get(
			referenceKey(resolveReference(part.reference, inputs.defaults))
		);
	}
	if (part.kind === "lease") {
		return inputs.leases.get(part.lease)?.[part.field];
	}
	return part.text;
}

/** Render `parts`. Every missing value is collected and reported in one error
 *  that names the placeholders, so nothing is written from a partial render. */
export function renderTemplate(
	parts: TemplatePart[],
	inputs: RenderInputs,
	file: string
): string {
	let output = "";
	const missing: string[] = [];
	for (const part of parts) {
		const value = lookup(part, inputs);
		if (value === undefined) {
			missing.push(part.kind === "text" ? "" : part.source);
			continue;
		}
		output += part.kind === "text" ? value : applyFilter(value, part.filter);
	}
	if (missing.length > 0) {
		throw new TemplateError(
			tf("{file}: no value for {placeholders}.", {
				file,
				placeholders: [...new Set(missing)].join(", "),
			})
		);
	}
	return output;
}

/** The secret references `parts` read, resolved against `defaults`. */
export function secretReferences(
	parts: TemplatePart[],
	defaults: { environment?: string; path?: string }
): ResolvedReference[] {
	return parts.flatMap((part) =>
		part.kind === "secret" ? [resolveReference(part.reference, defaults)] : []
	);
}
