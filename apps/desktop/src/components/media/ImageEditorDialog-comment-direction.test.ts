import { describe, expect, test } from "bun:test";
import { drawMarkups } from "./ImageEditorDialog-canvas.ts";
import { markupCommentLayout } from "./ImageEditorDialog-comment-direction.ts";
import type { ImageMarkup } from "./ImageEditorDialog-types.ts";

interface TextCall {
	align: CanvasTextAlign;
	direction: CanvasDirection;
	text: string;
	x: number;
}

/** A 2D context stand-in that records each fillText with its layout state. */
function recordingContext() {
	const texts: TextCall[] = [];
	const rects: number[][] = [];
	const context = {
		direction: "inherit" as CanvasDirection,
		fillStyle: "",
		font: "",
		lineWidth: 1,
		strokeStyle: "",
		textAlign: "left" as CanvasTextAlign,
		textBaseline: "alphabetic",
		arc() {},
		beginPath() {},
		fill() {},
		fillRect(...args: number[]) {
			rects.push(args);
		},
		fillText(text: string, x: number) {
			texts.push({
				align: context.textAlign,
				direction: context.direction,
				text,
				x,
			});
		},
		measureText(text: string) {
			return { width: text.length * 10 };
		},
		stroke() {},
	};
	return {
		context: context as unknown as CanvasRenderingContext2D,
		rects,
		texts,
	};
}

function comment(text: string): ImageMarkup {
	return { id: "c1", kind: "comment", point: { x: 0.5, y: 0.5 }, text };
}

describe("markup comment direction", () => {
	test("an Arabic comment draws right-to-left from the start edge", () => {
		const { context, rects, texts } = recordingContext();
		drawMarkups(context, [comment("السعر ٢٠ دولارًا؟")], 1000, 1000);
		const drawn = texts.at(-1);
		expect(drawn?.direction).toBe("rtl");
		expect(drawn?.align).toBe("start");
		// The box opens to the left of the pin at x=500.
		const [boxX = 0, , boxWidth = 0] = rects.at(-1) ?? [];
		expect(boxX + boxWidth).toBeLessThan(500);
		expect(drawn?.x).toBe(boxX + boxWidth - 6);
	});

	test("an English comment keeps the left-to-right layout", () => {
		const { context, rects, texts } = recordingContext();
		drawMarkups(context, [comment("Crop here")], 1000, 1000);
		const drawn = texts.at(-1);
		expect(drawn?.direction).toBe("ltr");
		expect(drawn?.align).toBe("start");
		const [boxX = 0] = rects.at(-1) ?? [];
		expect(boxX).toBeGreaterThan(500);
		expect(drawn?.x).toBe(boxX + 6);
	});

	test("a right-to-left box stays inside the canvas near the left edge", () => {
		const layout = markupCommentLayout({
			canvasWidth: 400,
			comment: "مرحبا",
			pinRadius: 13,
			pinX: 20,
			textWidth: 100,
		});
		expect(layout.boxX).toBe(4);
		expect(layout.textX).toBe(4 + 112 - 6);
	});
});
