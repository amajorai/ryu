import { activeDirection } from "@ryu/i18n/lite";
import { firstStrongDirection } from "@ryu/ui/components/editor/lib/export-docx-direction.ts";

// A markup comment is user-written text drawn onto the image, and the export
// draws it on a DETACHED canvas whose `direction: "inherit"` resolves to LTR
// whatever the page's `dir` is. So the comment says which way it reads itself:
// its first strong letter sets the bidi base (an Arabic note ending in a number
// or "?" keeps them on the correct side), and a right-to-left note opens its box
// to the left of the pin and is anchored at the box's right (start) edge, the
// mirror of a left-to-right one. A comment with no letters follows the UI.

/** Padding between the box edge and the text, in canvas pixels. */
const TEXT_INSET = 6;
/** Gap between the pin's edge and the box, in canvas pixels. */
const PIN_GAP = 5;
/** Smallest distance from the canvas edge, in canvas pixels. */
const EDGE = 4;

export interface MarkupCommentLayout {
	/** The left edge of the box (physical x). */
	boxX: number;
	direction: CanvasDirection;
	/** The x to `fillText` at with `textAlign: "start"`. */
	textX: number;
}

export interface MarkupCommentLayoutInput {
	canvasWidth: number;
	comment: string;
	pinRadius: number;
	pinX: number;
	textWidth: number;
}

export function markupCommentDirection(comment: string): CanvasDirection {
	return firstStrongDirection(comment) ?? activeDirection();
}

export function markupCommentLayout({
	canvasWidth,
	comment,
	pinRadius,
	pinX,
	textWidth,
}: MarkupCommentLayoutInput): MarkupCommentLayout {
	const direction = markupCommentDirection(comment);
	const boxWidth = textWidth + TEXT_INSET * 2;
	const maxBoxX = canvasWidth - textWidth - 16;
	const preferred =
		direction === "rtl"
			? pinX - pinRadius - PIN_GAP - boxWidth
			: pinX + pinRadius + PIN_GAP;
	const boxX = Math.max(EDGE, Math.min(maxBoxX, preferred));
	const textX =
		direction === "rtl" ? boxX + boxWidth - TEXT_INSET : boxX + TEXT_INSET;
	return { boxX, direction, textX };
}
