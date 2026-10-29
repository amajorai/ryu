import { z } from "zod";
import type { Citation } from "../inline-citation.tsx";

/** Fields read from native web-tool carriers; each field degrades independently. */
interface CitationFieldCarrier {
	description?: unknown;
	input?: unknown;
	link?: unknown;
	output?: unknown;
	result?: unknown;
	results?: unknown;
	snippet?: unknown;
	summary?: unknown;
	text?: unknown;
	title?: unknown;
	toolName?: unknown;
	type?: unknown;
	uri?: unknown;
	url?: unknown;
}

const citationCarrierSchema = z.custom<CitationFieldCarrier>(
	(value) => Array.isArray(value) || z.object({}).safeParse(value).success
);
const citationKindSchema = z.custom<CitationFieldCarrier & { type: string }>(
	(value) => {
		const carrier = citationCarrierSchema.safeParse(value);
		return carrier.success && z.string().safeParse(carrier.data.type).success;
	}
);
// Retain the original two input-property reads on a native part carrier.
const citationInputPartSchema = z.custom<
	CitationFieldCarrier & { input: CitationFieldCarrier }
>((value) => {
	const carrier = citationCarrierSchema.safeParse(value);
	return (
		carrier.success &&
		citationCarrierSchema.safeParse(carrier.data.input).success
	);
});
const citationStringSchema = z.string();
const citedWebToolSchema = z.enum(["WebFetch", "WebSearch"]);

type CitationOutputView =
	| { kind: "array"; items: unknown[]; carrier: CitationFieldCarrier }
	| { kind: "record"; carrier: CitationFieldCarrier }
	| { kind: "string"; text: string }
	| { kind: "ignored" };

/** Decode the native JSON-string form without rejecting unrelated payload fields. */
const citationOutputSchema = z
	.unknown()
	.transform((output): CitationOutputView => {
		let decoded = output;
		const encoded = citationStringSchema.safeParse(output);
		if (encoded.success) {
			try {
				decoded = JSON.parse(encoded.data);
			} catch {
				/* Raw prose remains a fetch description. */
			}
		}
		const carrier = citationCarrierSchema.safeParse(decoded);
		if (Array.isArray(decoded) && carrier.success) {
			return { kind: "array", items: decoded, carrier: carrier.data };
		}
		if (carrier.success) {
			return { kind: "record", carrier: carrier.data };
		}
		const text = citationStringSchema.safeParse(decoded);
		return text.success
			? { kind: "string", text: text.data }
			: { kind: "ignored" };
	});

const CODE_FENCE_SPLIT_RE = /(```[\s\S]*?```)/g;
const INLINE_CODE_SPLIT_RE = /(`[^`\n]+`)/g;
/** Bare `[n]` that is not already a markdown link `[n](...)` or definition `[n]:`. */
const BARE_CITE_MARKER_RE = /\[(\d+)\](?!\(|:)/g;

function asString(
	value: Parameters<typeof citationStringSchema.safeParse>[0]
): string | undefined {
	const text = citationStringSchema.safeParse(value);
	return text.success && text.data.trim() ? text.data : undefined;
}

function hostnameTitle(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function toolNameOf(
	part: CitationFieldCarrier
): z.output<typeof citedWebToolSchema> | null {
	if (part.type === "dynamic-tool") {
		const name = citedWebToolSchema.safeParse(part.toolName ?? "");
		return name.success ? name.data : null;
	}
	const kind = citationKindSchema.safeParse(part);
	const name =
		kind.success && kind.data.type.startsWith("tool-")
			? citedWebToolSchema.safeParse(kind.data.type.slice("tool-".length))
			: null;
	return name?.success ? name.data : null;
}

function pickUrl(record: CitationFieldCarrier): string | undefined {
	return asString(record.url) ?? asString(record.link) ?? asString(record.uri);
}

function citationFromWebFetch(
	part: CitationFieldCarrier
): Omit<Citation, "number">[] {
	const input = citationInputPartSchema.safeParse(part);
	const url = pickUrl(input.success ? input.data.input : {});
	if (!url) {
		return [];
	}
	const output = citationOutputSchema.parse(part.output);
	let title: string | undefined;
	let description: string | undefined;
	if (output.kind === "record" || output.kind === "array") {
		title = asString(output.carrier.title);
		description =
			asString(output.carrier.summary) ?? asString(output.carrier.text);
	} else if (output.kind === "string") {
		description = output.text;
	}
	return [
		{
			title: title ?? hostnameTitle(url),
			url,
			description: description?.slice(0, 240),
		},
	];
}

function citationsFromWebSearch(
	part: CitationFieldCarrier
): Omit<Citation, "number">[] {
	const output = citationOutputSchema.parse(part.output ?? part.result);
	// Bare arrays take precedence over a record's results property.
	const results =
		output.kind === "array"
			? output.items
			: output.kind === "record"
				? output.carrier.results
				: undefined;
	if (!Array.isArray(results)) {
		return [];
	}
	const out: Omit<Citation, "number">[] = [];
	for (const item of results) {
		const carrier = citationCarrierSchema.safeParse(item);
		if (!carrier.success) {
			continue;
		}
		const url = pickUrl(carrier.data);
		if (!url) {
			continue;
		}
		out.push({
			title: asString(carrier.data.title) ?? hostnameTitle(url),
			url,
			description:
				asString(carrier.data.snippet) ?? asString(carrier.data.description),
		});
	}
	return out;
}

/** Extract web citations, deduped and numbered in their original encounter order. */
export function extractCitations(parts: unknown[]): Citation[] {
	const collected: Omit<Citation, "number">[] = [];
	for (const part of parts) {
		const carrier = citationCarrierSchema.safeParse(part);
		if (!carrier.success) {
			continue;
		}
		const name = toolNameOf(carrier.data);
		if (name === "WebFetch") {
			collected.push(...citationFromWebFetch(carrier.data));
		} else if (name === "WebSearch") {
			collected.push(...citationsFromWebSearch(carrier.data));
		}
	}
	const seen = new Set<string>();
	const citations: Citation[] = [];
	for (const entry of collected) {
		if (seen.has(entry.url)) {
			continue;
		}
		seen.add(entry.url);
		citations.push({ ...entry, number: citations.length + 1 });
	}
	return citations;
}

/**
 * Turn bare `[n]` markers in assistant prose into markdown links that Markdown
 * can render as AICSS-style citation chips (`#ryu-cite-n`). Skips code fences,
 * inline code, existing links, and numbers with no matching citation.
 */
export function linkifyCitationMarkers(
	text: string,
	citations: Citation[] | undefined
): string {
	if (!citations?.length) {
		return text;
	}
	const known = new Set(citations.map((c) => c.number));
	return text
		.split(CODE_FENCE_SPLIT_RE)
		.map((segment) => {
			if (segment.startsWith("```")) {
				return segment;
			}
			return segment
				.split(INLINE_CODE_SPLIT_RE)
				.map((part) => {
					if (part.startsWith("`")) {
						return part;
					}
					return part.replace(BARE_CITE_MARKER_RE, (match, nStr: string) => {
						const n = Number(nStr);
						if (!known.has(n)) {
							return match;
						}
						return `[${n}](#ryu-cite-${n})`;
					});
				})
				.join("");
		})
		.join("");
}
