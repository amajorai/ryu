// apps/desktop/src/lib/manifest-copy.ts
//
// Copy an app or plugin manifest declares (`contributes.settings_tabs` fields,
// composer controls, Store tabs, …) arrives in English as data. The extractor
// catalogs each value as an exact literal, so it renders through `tl()`: a
// catalogued value comes back translated and anything else comes back as is.
//
// Copy holding ICU syntax is never catalogued (the extractor skips values with
// `{placeholders}` or `{{mustache}}`), and formatting it as a message would
// strip the braces, so it passes through verbatim.

import type { LiteralMessage } from "@ryu/i18n/react";

/** One manifest-declared string through the active locale's catalog. */
export function manifestCopy(tl: LiteralMessage, source: string): string {
	// Core forwards contributions verbatim, so a malformed manifest can put a
	// non-string here despite the type; leave it for the renderer to skip.
	if (
		typeof source !== "string" ||
		source.trim() === "" ||
		source.includes("{")
	) {
		return source;
	}
	return tl(source);
}

/** {@link manifestCopy} for an optional value. */
export function optionalManifestCopy(
	tl: LiteralMessage,
	source: string | undefined
): string | undefined {
	return typeof source === "string" ? manifestCopy(tl, source) : source;
}
