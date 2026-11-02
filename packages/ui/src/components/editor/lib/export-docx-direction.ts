import { EXPORT_TEXT_BLOCKS } from "./export-document-language.ts";

/** Letters of the right-to-left scripts the UI ships. */
const RIGHT_TO_LEFT_LETTER =
	/[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LETTER = /\p{L}/u;

/** The direction a block's first strong (letter) character gives it. */
export function firstStrongDirection(text: string): "ltr" | "rtl" | null {
	for (const character of text) {
		if (RIGHT_TO_LEFT_LETTER.test(character)) {
			return "rtl";
		}
		if (LETTER.test(character)) {
			return "ltr";
		}
	}
	return null;
}

function blockDirection(block: Element): "ltr" | "rtl" | null {
	const declared = block.getAttribute("dir");
	if (declared === "ltr" || declared === "rtl") {
		return declared;
	}
	return firstStrongDirection(block.textContent ?? "");
}

/** Table cells inherit `text-align: left` from the export stylesheet, not from the author. */
function keepsAuthoredAlignment(block: HTMLElement): boolean {
	const align = block.style.getPropertyValue("text-align");
	if (!align) {
		return false;
	}
	return !(block.matches("td, th") && align === "left");
}

/**
 * The Word converter has no bidi support and ignores `dir`, so a right-to-left
 * block is at least aligned to the right: every text block whose direction is
 * `rtl` (declared, or from its first strong character under `dir="auto"`) and
 * that has no alignment of its own gets `text-align: right`.
 */
export function alignRightToLeftBlocksForWord(root: ParentNode): void {
	for (const block of root.querySelectorAll<HTMLElement>(EXPORT_TEXT_BLOCKS)) {
		if (block.closest("pre, code") || keepsAuthoredAlignment(block)) {
			continue;
		}
		if (blockDirection(block) === "rtl") {
			block.style.setProperty("text-align", "right");
		}
	}
}
