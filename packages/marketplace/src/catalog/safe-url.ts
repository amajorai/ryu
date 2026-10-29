// packages/marketplace/src/catalog/safe-url.ts
//
// The render-layer guards for publisher-supplied strings that reach the DOM,
// shared by every catalog surface.
//
// Catalog sources are untrusted — a community listing's `homepage`, a release's
// `url`, a manifest's `privacyPolicyUrl` are all publisher-controlled strings.
// Core allowlists schemes on the way out, and this is the second half of that
// defence: nothing reaches an `<a href>` without parsing as http(s) here, so a
// `javascript:` or `data:` URL cannot execute even if a backend sanitizer is ever
// bypassed or a new source forgets to call one.
//
// {@link safeCssBackground} is the same posture one layer over: a manifest's
// `banner.background` / `banner.colors` land in a CSS background, which is a
// different sink with a different worst case.

import { z } from "zod";

const publisherUrlSchema = z.string();

/** Parse a publisher field at the DOM boundary, admitting only http(s) URLs. */
const httpUrlSchema = z.unknown().transform((value): string | null => {
	const input = publisherUrlSchema.safeParse(value);
	if (!(input.success && input.data)) {
		return null;
	}
	try {
		const parsed = new URL(input.data);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			return parsed.toString();
		}
		return null;
	} catch {
		return null;
	}
});

/** Return a normalized http(s) URL, or null for any unsupported publisher input. */
export const safeHttpUrl = httpUrlSchema.parse;

/** CSS value functions that make the browser FETCH something. These are what the
 *  guard below is for, and the list is deliberately short — see its doc. */
const CSS_FETCHING_FUNCTIONS =
	/url\s*\(|image-set\s*\(|cross-fade\s*\(|-moz-element\s*\(|expression\s*\(/i;

/** Return a publisher-supplied CSS background value only when it cannot make the
 *  browser fetch anything, else null.
 *
 *  WHY A BLOCKLIST OF FUNCTIONS AND NOT AN ALLOWLIST OF CHARACTERS. React assigns
 *  this into a style VALUE (`el.style.background = v`), so a `;` or `}` cannot
 *  escape into a new rule the way it could in a raw `style="…"` string — the
 *  browser just drops an unparseable declaration. What a value CAN still do is
 *  reference a remote asset, and that is the real leak: a `url(https://…)` in a
 *  listing's banner turns every viewer of that detail page into a beacon hit
 *  carrying their IP, without the page ever showing anything unusual. A character
 *  allowlist would additionally reject the legitimate forms authors do use —
 *  `oklch(…)`, `color-mix(…)`, `var(--…)`, multi-stop gradients — so it would be
 *  both stricter and less safe to maintain than naming the sinks.
 *
 *  The whole value is DROPPED rather than scrubbed: a background with one function
 *  removed is a different background, and silently painting something the author
 *  did not write is worse than falling back to the derived wash. */
export function safeCssBackground(value?: string | null): string | null {
	const trimmed = value?.trim();
	if (!trimmed) {
		return null;
	}
	return CSS_FETCHING_FUNCTIONS.test(trimmed) ? null : trimmed;
}
