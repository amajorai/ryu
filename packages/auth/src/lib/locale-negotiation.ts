// Turning a request's language signals into a locale a dictionary has.
//
// The website's `locale` cookie and the desktop/web clients send BCP 47 tags
// with a region (`pt-BR`, `zh-CN`), while Better Auth's error dictionaries
// are keyed by bare languages (`pt`, `zh`). `@better-auth/i18n`'s own cookie
// strategy compares the cookie verbatim, so `pt-BR` and `zh-CN` never
// matched and those users saw their browser language or English. These
// helpers match by language and script instead, the same rule
// `officialCatalogLocale` uses: `pt-BR`/`pt-PT` → `pt`, `zh-CN`/`zh-Hans` →
// `zh`, while `zh-TW` (Traditional) does not fall onto Simplified `zh`.

/** Read one cookie from a `Cookie` header, or null. */
export function cookieValue(
	header: string | null | undefined,
	name: string
): string | null {
	if (!header) {
		return null;
	}
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator > 0 && part.slice(0, separator).trim() === name) {
			const raw = part.slice(separator + 1).trim();
			try {
				return decodeURIComponent(raw);
			} catch {
				return null;
			}
		}
	}
	return null;
}

const MAX_ACCEPT_LANGUAGE_ENTRIES = 32;
const QUALITY = /^q=([01](?:\.\d{0,3})?)$/iu;

/**
 * The tags an `Accept-Language` header lists, best first: `q=0` and `*` are
 * dropped and equal weights keep the header's order.
 */
export function acceptLanguageTags(
	header: string | null | undefined
): string[] {
	if (!header) {
		return [];
	}
	const entries: { index: number; q: number; tag: string }[] = [];
	const parts = header.split(",").slice(0, MAX_ACCEPT_LANGUAGE_ENTRIES);
	for (const [index, part] of parts.entries()) {
		const [rawTag, ...params] = part.split(";");
		const tag = rawTag?.trim() ?? "";
		if (!tag || tag === "*") {
			continue;
		}
		let q = 1;
		for (const param of params) {
			const match = QUALITY.exec(param.trim());
			if (match?.[1]) {
				q = Number.parseFloat(match[1]);
			}
		}
		if (q > 0) {
			entries.push({ index, q, tag });
		}
	}
	return entries
		.sort((a, b) => b.q - a.q || a.index - b.index)
		.map((entry) => entry.tag);
}

const keyLanguageAndScript = new Map<string, string | null>();

function languageAndScript(tag: string): string | null {
	try {
		const maximized = new Intl.Locale(tag.replaceAll("_", "-")).maximize();
		return `${maximized.language}-${maximized.script ?? ""}`;
	} catch {
		return null;
	}
}

/**
 * The key of `available` that serves `tag`: an exact (case-insensitive)
 * match, else the key with the same language and script, else null.
 */
export function matchAvailableLocale(
	tag: string | null | undefined,
	available: readonly string[]
): string | null {
	const wanted = tag?.trim();
	if (!wanted) {
		return null;
	}
	const lower = wanted.toLowerCase();
	const exact = available.find((key) => key.toLowerCase() === lower);
	if (exact) {
		return exact;
	}
	const target = languageAndScript(wanted);
	if (!target) {
		return null;
	}
	return (
		available.find((key) => {
			// Dictionary keys repeat on every request; maximize each once.
			if (!keyLanguageAndScript.has(key)) {
				keyLanguageAndScript.set(key, languageAndScript(key));
			}
			return keyLanguageAndScript.get(key) === target;
		}) ?? null
	);
}

/**
 * The dictionary locale one request asks for: the `localeCookie` the person
 * picked, else the signed-in person's `stored` locale, else the best
 * `Accept-Language` entry a dictionary covers, else null (the caller's
 * default). This is the precedence recipient-locale.ts gives email.
 */
export function negotiateRequestLocale(input: {
	available: readonly string[];
	headers: Headers | null | undefined;
	localeCookie: string;
	stored?: unknown;
}): string | null {
	const { available, headers, localeCookie } = input;
	const chosen = matchAvailableLocale(
		cookieValue(headers?.get("cookie"), localeCookie),
		available
	);
	if (chosen) {
		return chosen;
	}
	const stored = matchAvailableLocale(
		typeof input.stored === "string" ? input.stored : null,
		available
	);
	if (stored) {
		return stored;
	}
	if (!headers) {
		return null;
	}
	for (const tag of acceptLanguageTags(headers.get("accept-language"))) {
		const match = matchAvailableLocale(tag, available);
		if (match) {
			return match;
		}
	}
	return null;
}
