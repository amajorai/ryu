import { activeDirection, activeLocale, translate as tl } from "@ryu/i18n/lite";

/** The language and base direction an exported editor document declares. */
export interface ExportDocumentLanguage {
	readonly dir: "ltr" | "rtl";
	readonly lang: string;
}

/**
 * Exports follow the language the UI is showing: its locale tag for `lang`
 * (spell-check, hyphenation, font fallback) and its direction as the
 * document's base direction. Each block still resolves its own direction
 * from its text through `dir="auto"` (see `markBlocksDirectionAuto`).
 */
export function exportDocumentLanguage(): ExportDocumentLanguage {
	return { dir: activeDirection(), lang: activeLocale() };
}

/** The exported document's `<title>`: its name, or a translated fallback. */
export function exportDocumentTitle(name?: string): string {
	return name?.trim() || tl("Ryu document");
}

const ESCAPED_ATTRIBUTE = /[&"<>]/g;
const ATTRIBUTE_ENTITIES: Record<string, string> = {
	'"': "&quot;",
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
};

/** Escapes text for an HTML attribute value or element text. */
export function escapeExportHtml(value: string): string {
	return value.replace(
		ESCAPED_ATTRIBUTE,
		(character) => ATTRIBUTE_ENTITIES[character] ?? character
	);
}

/** ` lang="ar" dir="rtl"`, ready to splice into an `<html>` start tag. */
export function htmlLanguageAttributes(
	language: ExportDocumentLanguage
): string {
	return ` lang="${escapeExportHtml(language.lang)}" dir="${language.dir}"`;
}

/**
 * Text blocks whose direction should follow their own first strong character.
 * Plate's static renderer writes paragraphs as `<div data-slate-type="p">`.
 */
export const EXPORT_TEXT_BLOCKS = [
	"p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,caption,figcaption,dt,dd",
	'[data-slate-type="p"]',
].join(",");

/**
 * Gives every text block without an explicit direction `dir="auto"`, so an
 * Arabic paragraph in an English document (or the reverse) keeps its own
 * order and alignment. Code stays as the editor renders it (forced `ltr`).
 */
export function markBlocksDirectionAuto(root: ParentNode): void {
	for (const block of root.querySelectorAll(EXPORT_TEXT_BLOCKS)) {
		if (block.hasAttribute("dir") || block.closest("pre, code")) {
			continue;
		}
		block.setAttribute("dir", "auto");
	}
}
