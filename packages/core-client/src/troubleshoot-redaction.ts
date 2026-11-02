// Secret and PII redaction for the troubleshooter: everything a report shows,
// saves or puts into an issue passes through `redactDiagnosticText` first.
// Pure and browser-safe; re-exported from `./troubleshoot.ts`.
//
// The rules run on the text as written and on its folded view (NFKC, invisible
// characters dropped, look-alike digits, dashes and spaces folded to ASCII), so
// a log line cannot carry a fullwidth or zero-width-split value off the device.

import { foldRedactionText } from "./redaction-fold.ts";

const SECRET_KEY_NAMES =
	"api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password|passwd|authorization";

/** Ordered rewrites. Each is idempotent: running redaction twice is a no-op. */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		"[REDACTED PRIVATE KEY]",
	],
	[
		/\b(Bearer|Basic)\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{8,}/gi,
		"$1 [REDACTED]",
	],
	// `Authorization: Token <value>` (only in a header: "token" is also prose).
	[
		/(\bAuthorization["']?\s*[:=]\s*["']?Token)\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{8,}/gi,
		"$1 [REDACTED]",
	],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED TOKEN]"],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED TOKEN]"],
	[/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED KEY]"],
	[/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[REDACTED TOKEN]"],
	[/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED KEY]"],
	[/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED KEY]"],
	[/\bhf_[A-Za-z0-9]{20,}\b/g, "[REDACTED TOKEN]"],
	[
		/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
		"[REDACTED JWT]",
	],
	// scheme://user:password@host → scheme://[REDACTED]@host
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
	// ?token=…&key=… query parameters.
	[
		/([?&](?:token|key|api_key|access_token|secret|sig|signature|code)=)[^&\s#]+/gi,
		"$1[REDACTED]",
	],
	// key=value, key: value, "key": "value", including prefixed environment
	// names such as RYU_CORE_TOKEN or OPENAI_API_KEY.
	[
		new RegExp(
			`(["']?\\b(?:[A-Za-z0-9]+[_-])*(?:${SECRET_KEY_NAMES})\\b["']?\\s*[=:]\\s*["']?)(?!\\[REDACTED)[^\\s"',;}&]+`,
			"gi"
		),
		"$1[REDACTED]",
	],
	// Starts only at the beginning of a run, so a long run with no `@` (a
	// pasted blob) is scanned once instead of once per character.
	[
		/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
		"[REDACTED EMAIL]",
	],
	// User home directories on every OS → `~`.
	[/\/(?:Users|home)\/[^/\s"'`]+/g, "~"],
	[/\b[A-Za-z]:\\Users\\[^\\\s"'`]+/g, "~"],
];

const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

/** Loopback, private, link-local and unspecified addresses carry no identity
 *  and are often the whole point of a diagnostic (`127.0.0.1:7980`). */
function isNonIdentifyingIpv4(octets: number[]): boolean {
	const [a = 0, b = 0] = octets;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	);
}

interface RedactionMatch {
	replacement: string;
	text: string;
}

/** Expands `$1`-style references the way `String.replace` would. */
function expandTemplate(
	template: string,
	groups: readonly (string | undefined)[]
): string {
	return template.replace(
		/\$(\d)/g,
		(_reference, index: string) => groups[Number(index) - 1] ?? ""
	);
}

/** The capture groups of a `replace` callback: everything before the offset. */
function captureGroups(rest: readonly unknown[]): (string | undefined)[] {
	const offset = rest.findIndex((value) => typeof value === "number");
	return rest
		.slice(0, offset === -1 ? rest.length : offset)
		.map((value) => (typeof value === "string" ? value : undefined));
}

/** One pass of every rule over `text`, recording each rewrite in `matches`. */
function redactionPass(
	text: string,
	homes: readonly string[],
	matches?: RedactionMatch[]
): string {
	let out = text;
	for (const home of homes) {
		if (out.includes(home)) {
			matches?.push({ replacement: "~", text: home });
			out = out.split(home).join("~");
		}
	}
	for (const [pattern, template] of REDACTIONS) {
		out = out.replace(pattern, (match: string, ...rest: unknown[]) => {
			const replacement = expandTemplate(template, captureGroups(rest));
			if (replacement !== match) {
				matches?.push({ replacement, text: match });
			}
			return replacement;
		});
	}
	return out.replace(IPV4, (match: string, ...rest: unknown[]) => {
		const octets = captureGroups(rest).slice(0, 4).map(Number);
		if (octets.some((octet) => octet > 255) || isNonIdentifyingIpv4(octets)) {
			return match;
		}
		matches?.push({ replacement: "[REDACTED IP]", text: match });
		return "[REDACTED IP]";
	});
}

/**
 * Strip credentials, emails, home paths and public IP addresses from free text
 * before it is shown, saved or put into an issue. `homeDir` additionally
 * rewrites that exact path (covers relocated homes the generic rules miss).
 *
 * The rules also run on the folded view of the text. When that view redacts
 * exactly what the as-written pass did, the text keeps its original form.
 * Otherwise (a fullwidth, zero-width-split or look-alike-digit value) the
 * folded, redacted view is returned, with every as-written match redacted in
 * it as well. Idempotent: redacting the result again changes nothing.
 */
export function redactDiagnosticText(
	text: string,
	options: { homeDir?: string | null } = {}
): string {
	const home = options.homeDir?.trim();
	const homes = home && home.length > 1 ? [home] : [];
	const rawMatches: RedactionMatch[] = [];
	const raw = redactionPass(text, homes, rawMatches);
	const folded = foldRedactionText(text);
	if (folded === text) {
		return raw;
	}
	const foldedHomes = [
		...new Set([...homes, ...homes.map(foldRedactionText)]),
	].filter((path) => path.length > 1);
	let rescanned = redactionPass(folded, foldedHomes);
	if (foldRedactionText(raw) === rescanned) {
		return raw;
	}
	for (const match of rawMatches) {
		const residue = foldRedactionText(match.text);
		if (residue !== "" && rescanned.includes(residue)) {
			rescanned = rescanned
				.split(residue)
				.join(foldRedactionText(match.replacement));
		}
	}
	return rescanned;
}
