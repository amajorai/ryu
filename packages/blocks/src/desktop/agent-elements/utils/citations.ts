import type { Citation } from "../inline-citation.tsx";

interface ToolPartLike {
	input?: unknown;
	output?: unknown;
	result?: unknown;
	toolName?: string;
	type?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** Best-effort parse of a tool output that may arrive as a JSON string. */
function normalizeOutput(output: unknown): unknown {
	if (typeof output !== "string") {
		return output;
	}
	try {
		return JSON.parse(output);
	} catch {
		return output;
	}
}

function hostnameTitle(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function toolNameOf(part: ToolPartLike): string {
	if (part.type === "dynamic-tool") {
		return part.toolName ?? "";
	}
	return typeof part.type === "string" && part.type.startsWith("tool-")
		? part.type.slice("tool-".length)
		: "";
}

function pickUrl(record: Record<string, unknown>): string | undefined {
	return asString(record.url) ?? asString(record.link) ?? asString(record.uri);
}

function citationFromWebFetch(part: ToolPartLike): Omit<Citation, "number">[] {
	const input = isRecord(part.input) ? part.input : {};
	const url = pickUrl(input);
	if (!url) {
		return [];
	}
	const output = normalizeOutput(part.output);
	let title: string | undefined;
	let description: string | undefined;
	if (isRecord(output)) {
		title = asString(output.title);
		description = asString(output.summary) ?? asString(output.text);
	} else if (typeof output === "string") {
		description = output;
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
	part: ToolPartLike
): Omit<Citation, "number">[] {
	const output = normalizeOutput(part.output ?? part.result);
	const results = isRecord(output) ? output.results : output;
	if (!Array.isArray(results)) {
		return [];
	}
	const out: Omit<Citation, "number">[] = [];
	for (const item of results) {
		if (!isRecord(item)) {
			continue;
		}
		const url = pickUrl(item);
		if (!url) {
			continue;
		}
		out.push({
			title: asString(item.title) ?? hostnameTitle(url),
			url,
			description: asString(item.snippet) ?? asString(item.description),
		});
	}
	return out;
}

/**
 * Extract cited sources from an assistant message's web tool parts. Only
 * entries with a real URL become citations (WebFetch always carries one;
 * WebSearch results may). Deduped by URL and numbered in first-seen order, so
 * the result is empty (renders nothing) when the turn used no web tools.
 */
export function extractCitations(parts: unknown[]): Citation[] {
	const collected: Omit<Citation, "number">[] = [];
	for (const part of parts) {
		if (!isRecord(part)) {
			continue;
		}
		const name = toolNameOf(part as ToolPartLike);
		if (name === "WebFetch") {
			collected.push(...citationFromWebFetch(part as ToolPartLike));
		} else if (name === "WebSearch") {
			collected.push(...citationsFromWebSearch(part as ToolPartLike));
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
