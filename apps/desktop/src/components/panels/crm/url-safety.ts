// Scheme safety for user-supplied URLs in Harbor (`@ryu/crm`).
//
// A `url` field's value is USER DATA that reaches an `href`, and the widest path
// into it is CSV import — which means the author of a spreadsheet somebody else
// imports gets to choose the scheme. `javascript:` in an href executes in the
// desktop app's own origin on click, so this decides what may be linked at all.
//
// Its own module rather than a helper inside `fields.tsx` so the rule can be tested
// without dragging the whole `@ryu/ui` import chain into a unit test. A security
// check nobody can cheaply test is a security check that rots.

/** Schemes safe to put in an `href`.
 *
 *  An ALLOWLIST, not a `javascript:` blocklist. A blocklist has to anticipate every
 *  spelling the URL parser accepts — `JaVaScript:`, an embedded tab or NUL,
 *  leading whitespace, `data:text/html`, `vbscript:` — and the PARSER, not the
 *  string, decides what the scheme is. Comparing a parsed `protocol` asks the same
 *  component the browser will ask. */
const NAVIGABLE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * The href to use for a `url` value, or `null` if it is not safely navigable.
 *
 * Returns the RESOLVED href rather than a yes/no, because a bare domain
 * (`acme.com/pricing`) is both extremely common in a CRM and not a URL: handing it
 * to an `href` unchanged makes a relative link against the app's own origin, which
 * goes nowhere. It gets an explicit `https://` instead — and that upgrade happens
 * only for values that fail to parse as absolute at all, so it can never turn a
 * rejected scheme into an accepted one.
 *
 * A rejected value is not dropped by the caller; it renders as plain text, still
 * fully readable, just not clickable.
 */
export function safeHref(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return null;
	}
	try {
		// Absolute already: judged on the scheme the parser reports, not on how the
		// string looks.
		return NAVIGABLE_SCHEMES.has(new URL(trimmed).protocol) ? trimmed : null;
	} catch {
		// `new URL` throws here only when there is no parseable scheme at all. Try
		// it as a bare host, and accept it only if that yields a real URL.
		try {
			const upgraded = `https://${trimmed}`;
			// Constructed for validation; the string is what we return.
			new URL(upgraded);
			return upgraded;
		} catch {
			return null;
		}
	}
}

/** Return a mailto destination for a plain address, never an injected header. */
export function safeMailtoHref(raw: string): string | null {
	const email = raw.trim();
	if (
		!email ||
		/[\r\n?#;,<>\s]/u.test(email) ||
		!/^[a-z0-9.!#$%&'*+/=^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/iu.test(email)
	) {
		return null;
	}
	return `mailto:${email}`;
}
