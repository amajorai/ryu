/*
 * The scratch card's frosted foil, painted straight onto the rub canvas.
 *
 * The foil used to be a blurred DOM copy masked by `canvas.toDataURL()`. Every
 * rub swapped the CSS mask to a fresh data URL, and while the browser decoded
 * it the mask was briefly missing, so the whole code flashed through mid-rub.
 * Painting the frost into the canvas itself means erasing a pixel only ever
 * reveals that pixel: no async image, no flash, no per-frame PNG encode.
 */

/** One line of the reward, drawn blurred at its on-screen position. */
export interface FoilText {
	color: string;
	font: string;
	letterSpacing?: string;
	text: string;
	/** Centre of the line, in canvas CSS pixels. */
	x: number;
	y: number;
}

/** A sharp line printed on top of the veil ("Rub to reveal"). */
export interface FoilLabel {
	color: string;
	font: string;
	text: string;
	y: number;
}

export interface FoilScene {
	/** The reward's own background (may be translucent). */
	background: string;
	/** Opaque colour laid down first so the foil is never see-through. */
	base: string;
	blurPx: number;
	height: number;
	labels: FoilLabel[];
	/** Reward lines; drawn only when the context can blur them. */
	texts: FoilText[];
	veilAlpha: number;
	veilColor: string;
	width: number;
}

const LABEL_INSET_PX = 12;

/** Canvas `filter` is missing on older Safari; never draw the code unblurred. */
export const canBlurCanvas = (ctx: CanvasRenderingContext2D): boolean =>
	typeof ctx.filter === "string";

const setLetterSpacing = (ctx: CanvasRenderingContext2D, value: string) => {
	if ("letterSpacing" in ctx) {
		ctx.letterSpacing = value;
	}
};

/**
 * Paint a fully opaque frosted foil. Every pixel ends with alpha 1, so the
 * scratch progress (share of fully erased pixels) starts at zero.
 */
export const drawFoil = (
	ctx: CanvasRenderingContext2D,
	scene: FoilScene
): void => {
	ctx.globalCompositeOperation = "source-over";
	ctx.globalAlpha = 1;
	ctx.fillStyle = scene.base;
	ctx.fillRect(0, 0, scene.width, scene.height);
	ctx.fillStyle = scene.background;
	ctx.fillRect(0, 0, scene.width, scene.height);

	ctx.textAlign = "center";
	ctx.textBaseline = "middle";

	if (canBlurCanvas(ctx)) {
		ctx.save();
		ctx.filter = `blur(${scene.blurPx}px)`;
		for (const line of scene.texts) {
			ctx.font = line.font;
			ctx.fillStyle = line.color;
			setLetterSpacing(ctx, line.letterSpacing ?? "0px");
			ctx.fillText(line.text, line.x, line.y);
		}
		ctx.restore();
	}

	ctx.globalAlpha = scene.veilAlpha;
	ctx.fillStyle = scene.veilColor;
	ctx.fillRect(0, 0, scene.width, scene.height);
	ctx.globalAlpha = 1;

	const maxWidth = Math.max(1, scene.width - LABEL_INSET_PX * 2);
	setLetterSpacing(ctx, "0px");
	for (const label of scene.labels) {
		ctx.font = label.font;
		ctx.fillStyle = label.color;
		ctx.fillText(label.text, scene.width / 2, label.y, maxWidth);
	}
};

/** Size the canvas backing store to its box at device resolution. */
export const fitCanvas = (
	canvas: HTMLCanvasElement
): { ctx: CanvasRenderingContext2D; width: number; height: number } | null => {
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}
	const ratio = window.devicePixelRatio || 1;
	const { width, height } = canvas.getBoundingClientRect();
	canvas.width = Math.floor(width * ratio);
	canvas.height = Math.floor(height * ratio);
	ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
	return { ctx, width, height };
};

/** Describe a rendered text element as a foil line relative to the canvas. */
export const foilTextFrom = (
	element: HTMLElement,
	canvasRect: DOMRect
): FoilText => {
	const style = getComputedStyle(element);
	const rect = element.getBoundingClientRect();
	return {
		color: style.color,
		font: `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
		letterSpacing:
			style.letterSpacing === "normal" ? "0px" : style.letterSpacing,
		text: element.textContent ?? "",
		x: rect.left - canvasRect.left + rect.width / 2,
		y: rect.top - canvasRect.top + rect.height / 2,
	};
};
