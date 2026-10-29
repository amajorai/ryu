// packages/services/src/transport/rate-limit.ts
//
// `Retry-After` (RFC 9110 §10.2.3) and the IETF RateLimit fields
// (draft-ietf-httpapi-ratelimit-headers-11): `RateLimit: "<name>";r=<n>;t=<s>`
// and `RateLimit-Policy: "<name>";q=<n>;w=<s>`, both Structured Field Lists
// (RFC 9651). The parsers tolerate several items, tokens instead of strings and
// unknown parameters, and return null rather than throwing on garbage.

/** A rate-limit snapshot from one response, merged from `RateLimit` and `RateLimit-Policy`. */
export interface RyuRateLimit {
	/** Requests allowed per window (`q`). */
	limit: number | null;
	/** The policy name the server gave. */
	policy: string | null;
	/** Requests left in this window (`r`). */
	remaining: number | null;
	/** Seconds until the window resets (`t`). */
	resetSeconds: number | null;
	/** Window length in seconds (`w`). */
	windowSeconds: number | null;
}

/** One `RateLimit` item. */
export interface RateLimitItem {
	policy: string;
	remaining: number | null;
	resetSeconds: number | null;
}

/** One `RateLimit-Policy` item. */
export interface RateLimitPolicyItem {
	policy: string;
	quota: number | null;
	windowSeconds: number | null;
}

interface SfItem {
	params: Map<string, string>;
	value: string;
}

const DELTA_SECONDS = /^\d+$/u;
/** An HTTP-date always names a weekday or month; bare numbers are not dates. */
const HAS_LETTER = /[a-z]/iu;
const SF_INTEGER = /^-?\d+$/u;

/**
 * `Retry-After` in whole seconds from now: delta-seconds or an HTTP-date.
 * Returns null when the header is absent or unparseable; a past date is 0.
 */
export function parseRetryAfter(
	value: string | null | undefined,
	now: number = Date.now()
): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		return null;
	}
	if (DELTA_SECONDS.test(trimmed)) {
		return Number(trimmed);
	}
	const date = HAS_LETTER.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
	if (Number.isNaN(date)) {
		return null;
	}
	return Math.max(0, Math.ceil((date - now) / 1000));
}

/** Reads one sf-string starting at the opening quote; returns the value and the index after it. */
function readSfString(
	input: string,
	start: number
): { end: number; value: string } {
	let value = "";
	let index = start + 1;
	while (index < input.length) {
		const char = input[index];
		if (char === "\\" && index + 1 < input.length) {
			value += input[index + 1];
			index += 2;
			continue;
		}
		if (char === '"') {
			return { end: index + 1, value };
		}
		value += char;
		index += 1;
	}
	return { end: index, value };
}

/** Splits a Structured Field List into members, respecting quoted strings. */
function splitMembers(input: string): string[] {
	const members: string[] = [];
	let current = "";
	let index = 0;
	while (index < input.length) {
		const char = input[index];
		if (char === '"') {
			const { end } = readSfString(input, index);
			current += input.slice(index, end);
			index = end;
			continue;
		}
		if (char === ",") {
			members.push(current);
			current = "";
		} else {
			current += char;
		}
		index += 1;
	}
	members.push(current);
	return members.map((member) => member.trim()).filter(Boolean);
}

/** Parses `"name";a=1;b=2` (or a bare token) into its value and parameters. */
function parseSfItem(member: string): SfItem | null {
	let value: string;
	let index: number;
	if (member.startsWith('"')) {
		const string = readSfString(member, 0);
		value = string.value;
		index = string.end;
	} else {
		const semicolon = member.indexOf(";");
		index = semicolon === -1 ? member.length : semicolon;
		value = member.slice(0, index).trim();
	}
	if (value === "") {
		return null;
	}
	const params = new Map<string, string>();
	for (const part of member.slice(index).split(";")) {
		const trimmed = part.trim();
		if (trimmed === "") {
			continue;
		}
		const equals = trimmed.indexOf("=");
		const key = (equals === -1 ? trimmed : trimmed.slice(0, equals))
			.trim()
			.toLowerCase();
		const raw = equals === -1 ? "?1" : trimmed.slice(equals + 1).trim();
		params.set(key, raw.startsWith('"') ? readSfString(raw, 0).value : raw);
	}
	return { params, value };
}

function sfInteger(value: string | undefined): number | null {
	if (value === undefined || !SF_INTEGER.test(value)) {
		return null;
	}
	return Number(value);
}

function parseSfList(header: string | null | undefined): SfItem[] {
	if (!header) {
		return [];
	}
	const items: SfItem[] = [];
	for (const member of splitMembers(header)) {
		const item = parseSfItem(member);
		if (item) {
			items.push(item);
		}
	}
	return items;
}

/** Every item of a `RateLimit` field. */
export function parseRateLimit(
	header: string | null | undefined
): RateLimitItem[] {
	return parseSfList(header).map((item) => ({
		policy: item.value,
		remaining: sfInteger(item.params.get("r")),
		resetSeconds: sfInteger(item.params.get("t")),
	}));
}

/** Every item of a `RateLimit-Policy` field. */
export function parseRateLimitPolicy(
	header: string | null | undefined
): RateLimitPolicyItem[] {
	return parseSfList(header).map((item) => ({
		policy: item.value,
		quota: sfInteger(item.params.get("q")),
		windowSeconds: sfInteger(item.params.get("w")),
	}));
}

/**
 * The response's rate-limit state: the first `RateLimit` item joined with the
 * `RateLimit-Policy` item of the same name (or the first policy when the
 * response sends a policy only). Null when neither field is present.
 */
export function readRateLimit(headers: Headers): RyuRateLimit | null {
	const limits = parseRateLimit(headers.get("RateLimit"));
	const policies = parseRateLimitPolicy(headers.get("RateLimit-Policy"));
	const current = limits[0];
	const policy = current
		? (policies.find((item) => item.policy === current.policy) ?? null)
		: (policies[0] ?? null);
	if (!(current || policy)) {
		return null;
	}
	return {
		limit: policy?.quota ?? null,
		policy: current?.policy ?? policy?.policy ?? null,
		remaining: current?.remaining ?? null,
		resetSeconds: current?.resetSeconds ?? null,
		windowSeconds: policy?.windowSeconds ?? null,
	};
}
