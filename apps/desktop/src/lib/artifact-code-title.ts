import type { LiteralMessage } from "@ryu/i18n/react";

const SNIPPET_TITLE = /^(\S+) snippet$/u;

/**
 * The title to show for an artifact. A code artifact's stored title stays in
 * English (`titleFor` in artifacts.ts); a generated "<Language> snippet" title
 * of a code or file artifact becomes one translated message with the language
 * name as a value. The fixed generated titles of svg and space artifacts are
 * translated here, which also catalogs them for the DOM localizer that
 * translates them where the raw title is rendered (artifacts.ts is too large
 * to wrap them at their source). Every other title is returned as written.
 */
export function artifactDisplayTitle(
	artifact: { kind: string; title: string },
	tl: LiteralMessage
): string {
	if (artifact.kind === "svg" && artifact.title === "Vector image") {
		return tl("Vector image");
	}
	if (artifact.kind === "space" && artifact.title === "Space document") {
		return tl("Space document");
	}
	if (artifact.kind !== "code" && artifact.kind !== "file") {
		return artifact.title;
	}
	const match = SNIPPET_TITLE.exec(artifact.title);
	return match?.[1]
		? tl("{language} snippet", { language: match[1] })
		: artifact.title;
}
