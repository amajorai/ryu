import { describe, expect, test } from "bun:test";
import {
	canBlurCanvas,
	drawFoil,
	type FoilScene,
} from "./scratch-card-foil.ts";

interface DrawCall {
	alpha: number;
	fill: string;
	filter: string;
	kind: "rect" | "text";
	text?: string;
}

/** A 2D context stand-in that records what was painted and how. */
const recordingContext = (supportsFilter: boolean) => {
	const calls: DrawCall[] = [];
	const stack: string[] = [];
	const ctx: Record<string, unknown> = {
		globalAlpha: 1,
		globalCompositeOperation: "",
		fillStyle: "",
		font: "",
		textAlign: "",
		textBaseline: "",
		save: () => stack.push(String(ctx.filter ?? "none")),
		restore: () => {
			const previous = stack.pop();
			if (supportsFilter) {
				ctx.filter = previous;
			}
		},
		fillRect: () =>
			calls.push({
				alpha: Number(ctx.globalAlpha),
				fill: String(ctx.fillStyle),
				filter: String(ctx.filter ?? "none"),
				kind: "rect",
			}),
		fillText: (text: string) =>
			calls.push({
				alpha: Number(ctx.globalAlpha),
				fill: String(ctx.fillStyle),
				filter: String(ctx.filter ?? "none"),
				kind: "text",
				text,
			}),
	};
	if (supportsFilter) {
		ctx.filter = "none";
	}
	return { calls, ctx: ctx as unknown as CanvasRenderingContext2D };
};

const scene: FoilScene = {
	background: "rgba(240, 240, 240, 0.5)",
	base: "rgb(255, 255, 255)",
	blurPx: 10,
	height: 90,
	labels: [
		{ color: "black", font: "600 14px sans", text: "Rub to reveal", y: 40 },
	],
	texts: [
		{ color: "blue", font: "500 14px sans", text: "30% off", x: 80, y: 20 },
		{ color: "black", font: "500 30px mono", text: "LAUNCH30", x: 80, y: 45 },
	],
	veilAlpha: 0.25,
	veilColor: "rgb(255, 255, 255)",
	width: 160,
};

describe("drawFoil", () => {
	test("starts from an opaque base so a translucent theme never shows the code", () => {
		const { calls, ctx } = recordingContext(true);
		drawFoil(ctx, scene);
		expect(calls[0]).toMatchObject({
			kind: "rect",
			fill: scene.base,
			alpha: 1,
		});
	});

	test("draws the code only through a blur, then a sharp rub label on top", () => {
		const { calls, ctx } = recordingContext(true);
		drawFoil(ctx, scene);
		const code = calls.find((call) => call.text === "LAUNCH30");
		expect(code?.filter).toBe("blur(10px)");
		const label = calls.find((call) => call.text === "Rub to reveal");
		expect(label?.filter).toBe("none");
		expect(calls.indexOf(label as DrawCall)).toBeGreaterThan(
			calls.indexOf(code as DrawCall)
		);
	});

	test("never paints the code sharp when the canvas cannot blur", () => {
		const { calls, ctx } = recordingContext(false);
		expect(canBlurCanvas(ctx)).toBe(false);
		drawFoil(ctx, scene);
		expect(calls.some((call) => call.text === "LAUNCH30")).toBe(false);
		expect(calls.some((call) => call.text === "Rub to reveal")).toBe(true);
	});
});
