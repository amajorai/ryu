// The UI language a sandboxed Companion document starts in and follows.
//
// A null-origin srcdoc frame does not inherit the host's `<html lang dir>`, so
// both srcdoc builders bake the host's current locale into the document and then
// follow `i18n.subscribe` (a local host capability every frame may use) so the
// frame's `lang`/`dir` track a language change without a remount, the same way
// the theme tokens do.

import { directionForLocale } from "@ryu/i18n/lite";

/** The host's UI language for a Companion frame. */
export interface CompanionLocale {
	/** Optional explicit direction; derived from `locale` when omitted. */
	direction?: "ltr" | "rtl";
	/** A BCP 47 tag, e.g. `ar` or `pt-BR`. */
	locale: string;
}

/** Sanitized `lang` and `dir` values for a Companion document. */
export interface CompanionDocumentLocale {
	dir: "ltr" | "rtl";
	lang: string;
}

const FALLBACK: CompanionDocumentLocale = { dir: "ltr", lang: "en" };

/** Canonicalize a host locale; anything malformed falls back to English. */
export function companionDocumentLocale(
	input: CompanionLocale | null | undefined
): CompanionDocumentLocale {
	if (!input || typeof input.locale !== "string") {
		return FALLBACK;
	}
	let lang: string | undefined;
	try {
		lang = Intl.getCanonicalLocales(input.locale)[0];
	} catch {
		return FALLBACK;
	}
	if (!(lang && /^[A-Za-z0-9-]{1,64}$/.test(lang))) {
		return FALLBACK;
	}
	const dir =
		input.direction === "rtl" || input.direction === "ltr"
			? input.direction
			: directionForLocale(lang);
	return { dir, lang };
}

/** `lang="…" dir="…"` attributes for the frame's `<html>` tag. Both values are
 *  restricted to `[A-Za-z0-9-]`, so they cannot break out of the attribute. */
export function companionHtmlLocaleAttributes(
	input: CompanionLocale | null | undefined
): string {
	const { dir, lang } = companionDocumentLocale(input);
	return `lang="${lang}" dir="${dir}"`;
}

/** Bootstrap fragment that applies a host i18n snapshot to `<html>` and follows
 *  later changes. Expects `callStream(method, args, onChunk)` in scope. Pass the
 *  initial locale to apply it immediately (Path B, whose `<html>` the app owns). */
export function companionLocaleScript(
	initial?: CompanionLocale | null
): string {
	const seed = initial
		? `\napplyHostLocale(${JSON.stringify(companionDocumentLocale(initial))});`
		: "";
	return `
function applyHostLocale(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  var root = document.documentElement;
  var lang = typeof snapshot.lang === "string" ? snapshot.lang : snapshot.locale;
  if (typeof lang === "string" && /^[A-Za-z0-9-]{1,64}$/.test(lang)) root.setAttribute("lang", lang);
  var dir = snapshot.dir || snapshot.direction;
  if (dir === "rtl" || dir === "ltr") root.setAttribute("dir", dir);
}
function followHostLocale() {
  try {
    var h = callStream("i18n.subscribe", [{}], function (d) {
      try { applyHostLocale(JSON.parse(d)); } catch (e) {}
    });
    h.promise.catch(function () {});
  } catch (e) {}
}${seed}
`;
}
