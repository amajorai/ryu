// packages/services/src/transport/deprecation.ts
//
// Deprecation signalling as the control-plane host emits it
// (apps/server/src/deprecation.ts):
//
// - `Deprecation` (RFC 9745): a Structured Field Date `@<unix seconds>`; an
//   HTTP-date (the earlier draft's form) is accepted too.
// - `Sunset` (RFC 8594): an HTTP-date.
// - `Link; rel="deprecation"` to the policy and `rel="successor-version"`
//   (RFC 5829) to the replacement, possibly across several Link fields.

/** What a response said about its route's deprecation. */
export interface RyuDeprecation {
	/** When the route was (or will be) deprecated. */
	deprecatedAt: Date | null;
	/** The `rel="deprecation"` link: the published deprecation policy. */
	policyUrl: string | null;
	/** The `rel="successor-version"` link: the replacement route. */
	successorUrl: string | null;
	/** When the route may stop responding. */
	sunsetAt: Date | null;
}

/** One parsed Link value. */
export interface LinkValue {
	params: Record<string, string>;
	rels: string[];
	url: string;
}

const SF_DATE = /^@(-?\d+)$/u;
const LINK_VALUE = /^<([^>]*)>(.*)$/su;

/** `Deprecation`: `@<unix seconds>` or an HTTP-date. Null when absent or unparseable. */
export function parseDeprecationDate(
	value: string | null | undefined
): Date | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	const sfDate = SF_DATE.exec(trimmed);
	if (sfDate?.[1]) {
		return new Date(Number(sfDate[1]) * 1000);
	}
	return parseHttpDate(trimmed);
}

/** An HTTP-date always names a weekday or month; bare numbers are not dates. */
const HAS_LETTER = /[a-z]/iu;

/** An HTTP-date (or another `Date.parse`-able date with a month name). Null when absent or unparseable. */
export function parseHttpDate(value: string | null | undefined): Date | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	const time = HAS_LETTER.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
	return Number.isNaN(time) ? null : new Date(time);
}

/** Splits a Link field on top-level commas, ignoring commas inside `<…>` and quotes. */
function splitLinkValues(header: string): string[] {
	const values: string[] = [];
	let current = "";
	let inUrl = false;
	let inQuote = false;
	for (const char of header) {
		if (char === "<" && !inQuote) {
			inUrl = true;
		} else if (char === ">" && !inQuote) {
			inUrl = false;
		} else if (char === '"' && !inUrl) {
			inQuote = !inQuote;
		}
		if (char === "," && !(inUrl || inQuote)) {
			values.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	values.push(current);
	return values.map((value) => value.trim()).filter(Boolean);
}

function unquote(value: string): string {
	const trimmed = value.trim();
	return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1
		? trimmed.slice(1, -1).replace(/\\(.)/gu, "$1")
		: trimmed;
}

/** Parses an RFC 8288 Link field (one or more values) into URLs, rels and parameters. */
export function parseLinkHeader(
	header: string | null | undefined
): LinkValue[] {
	if (!header) {
		return [];
	}
	const links: LinkValue[] = [];
	for (const value of splitLinkValues(header)) {
		const match = LINK_VALUE.exec(value);
		if (!match) {
			continue;
		}
		const params: Record<string, string> = {};
		for (const part of (match[2] ?? "").split(";")) {
			const equals = part.indexOf("=");
			if (equals === -1) {
				continue;
			}
			const key = part.slice(0, equals).trim().toLowerCase();
			if (key) {
				params[key] = unquote(part.slice(equals + 1));
			}
		}
		links.push({
			params,
			rels: (params.rel ?? "").toLowerCase().split(/\s+/u).filter(Boolean),
			url: (match[1] ?? "").trim(),
		});
	}
	return links;
}

/**
 * The deprecation state a response announces, or null when it carries neither
 * `Deprecation` nor `Sunset`. `Headers.get` joins repeated Link fields with
 * ", ", which {@link parseLinkHeader} splits again.
 */
export function parseDeprecation(headers: Headers): RyuDeprecation | null {
	const deprecation = headers.get("Deprecation");
	const sunset = headers.get("Sunset");
	if (deprecation === null && sunset === null) {
		return null;
	}
	const links = parseLinkHeader(headers.get("Link"));
	return {
		deprecatedAt: parseDeprecationDate(deprecation),
		policyUrl:
			links.find((link) => link.rels.includes("deprecation"))?.url ?? null,
		successorUrl:
			links.find((link) => link.rels.includes("successor-version"))?.url ??
			null,
		sunsetAt: parseHttpDate(sunset),
	};
}
