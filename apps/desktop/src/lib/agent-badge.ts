// apps/desktop/src/lib/agent-badge.ts
//
// Renders a minimal, Apple-style "employee card" for an agent — the face that
// gets composited onto the Lanyard badge (see AgentLanyardCard). We draw to an
// offscreen canvas and return data URLs rather than mounting DOM: deterministic,
// dependency-free at runtime, and safe to feed straight into the WebGL texture
// (same-origin canvas, never tainted).
//
// Design: a clean white ID card — the Ryu logo mark up top, a small tracked
// title, the agent's name, a short description, and a scannable QR code. One
// accent hue is derived from the agent so each card is subtly its own, but the
// card stays quiet and monochrome everywhere else.

import qr from "qr.js";

export interface AgentBadgeInput {
	/** Built-in agents get a "CORE STAFF" title instead of "AGENT". */
	builtIn: boolean;
	/** Short description of what the agent does. */
	description: string | null;
	/** Engine id — seeds the accent hue and the model/role subtitle. */
	engine: string | null;
	/** Agent display name — the headline on the card. */
	name: string;
	/** Node / workspace name, shown on the back. */
	node: string | null;
	/** Model/role label shown as a subtitle under the name. */
	role: string | null;
	/** Version string, shown under the QR code. */
	version: string;
}

export interface AgentBadgeImages {
	back: string;
	front: string;
}

// Portrait aspect ~0.71 matches the card model's face (collider 1.6 × 2.25).
const CARD_W = 600;
const CARD_H = 844;
const MARGIN = 56;

// Apple-ish neutral palette.
const INK = "#1d1d1f";
const MUTED = "#6e6e73";
const FAINT = "#a1a1a6";
const CARD_TOP = "#ffffff";
const CARD_BOTTOM = "#f5f5f7";
const HAIRLINE = "rgba(0,0,0,0.08)";
const LANDING_DITHER = {
	color: "#B497CF",
	edgeFade: 0.5,
	enableRipples: true,
	patternDensity: 1,
	patternScale: 2,
	pixelSize: 3,
	rippleIntensityScale: 1,
	rippleSpeed: 0.3,
	rippleThickness: 0.1,
	speed: 0.5,
	transparent: true,
	variant: "square",
} as const;

// The Ryu mark, straight from /assets/logos/ryu_*.svg (viewBox 0 0 24 24).
const RYU_PATH =
	"M12,24c9.2,0,12.9-4.8,12.4-14.6C24.1,0.3,12.8-3.7,8.8,5.4c-2.2,5.7,1.1,7.9-2.9,12.6c-0.9,1.1-1.8,2-2.7,3.1c-1.2,1.3,0.7,2.2,1.9,2.2C7.4,23.3,9.7,24,12,24z";

const ROLE_FALLBACK = "Autonomous Agent";

const RE_ENGINE_SPLIT = /[:/]/;
const RE_SEPARATORS = /[-_]/g;
const RE_NON_ALNUM = /[^a-z0-9]+/g;
const RE_EDGE_DASHES = /^-+|-+$/g;
const RE_WHITESPACE = /\s+/;

function hashString(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		// biome-ignore lint/suspicious/noBitwiseOperators: standard 32-bit string hash
		hash = (Math.imul(hash, 31) + value.charCodeAt(i)) >>> 0;
	}
	return hash;
}

function accentHue(seed: string): number {
	return hashString(seed || "ryu") % 360;
}

function prettyEngine(engine: string | null): string {
	if (!engine) {
		return "AGENT";
	}
	const raw = engine.startsWith("acp:") ? engine.slice(4) : engine;
	const base = raw.split(RE_ENGINE_SPLIT).pop() ?? raw;
	return base.replace(RE_SEPARATORS, " ").toUpperCase();
}

function slug(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(RE_NON_ALNUM, "-")
			.replace(RE_EDGE_DASHES, "") || "agent"
	);
}

/** Shrink a font until the text fits `maxWidth`, returning the chosen px size. */
function fitFontSize(
	ctx: CanvasRenderingContext2D,
	text: string,
	font: (px: number) => string,
	startPx: number,
	minPx: number,
	maxWidth: number
): number {
	let size = startPx;
	while (size > minPx) {
		ctx.font = font(size);
		if (ctx.measureText(text).width <= maxWidth) {
			break;
		}
		size -= 2;
	}
	return size;
}

/** Word-wrap `text` to at most `maxLines`, ellipsizing the final line if needed. */
function wrapLines(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number,
	maxLines: number
): string[] {
	const words = text.trim().split(RE_WHITESPACE).filter(Boolean);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (ctx.measureText(candidate).width <= maxWidth || !current) {
			current = candidate;
		} else {
			lines.push(current);
			current = word;
			if (lines.length === maxLines) {
				break;
			}
		}
	}
	if (lines.length < maxLines && current) {
		lines.push(current);
	}
	// If we ran out of lines with text remaining, ellipsize the last line.
	const consumed = lines.join(" ").split(RE_WHITESPACE).filter(Boolean).length;
	const lastIndex = lines.length - 1;
	if (consumed < words.length && lastIndex >= 0) {
		let last = lines[lastIndex] ?? "";
		while (ctx.measureText(`${last}…`).width > maxWidth && last.length > 1) {
			last = last.slice(0, -1).trimEnd();
		}
		lines[lastIndex] = `${last}…`;
	}
	return lines;
}

function fillCard(ctx: CanvasRenderingContext2D, accent: string): void {
	const bg = ctx.createLinearGradient(0, 0, 0, CARD_H);
	bg.addColorStop(0, CARD_TOP);
	bg.addColorStop(1, CARD_BOTTOM);
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, CARD_W, CARD_H);
	drawLandingDither(ctx);
	// A single thin accent bar at the very top is the only colour on the card.
	ctx.fillStyle = accent;
	ctx.fillRect(0, 0, CARD_W, 5);
}

function drawLandingDither(ctx: CanvasRenderingContext2D): void {
	const pixel = LANDING_DITHER.pixelSize;
	const noiseCell = 8 * pixel;
	const centerX = CARD_W / 2;
	const centerY = CARD_H / 2;
	const maxDistance = Math.hypot(centerX, centerY);

	ctx.save();
	ctx.fillStyle = LANDING_DITHER.color;
	for (let y = 0; y < CARD_H; y += pixel) {
		for (let x = 0; x < CARD_W; x += pixel) {
			const noiseX = Math.floor((x - centerX) / noiseCell);
			const noiseY = Math.floor((y - centerY) / noiseCell);
			const grain = hashFloat(
				noiseX * 127.1 + noiseY * 311.7 + LANDING_DITHER.patternScale * 57.3
			);
			const threshold = bayer8(x / pixel, y / pixel);
			const feed =
				grain * 0.74 - 0.22 + (LANDING_DITHER.patternDensity - 0.5) * 0.3;
			if (feed + threshold - 0.5 < 0.5) {
				continue;
			}
			const distance = Math.hypot(x - centerX, y - centerY) / maxDistance;
			const fade = Math.max(0, 1 - distance * (1 + LANDING_DITHER.edgeFade));
			const wave =
				Math.sin(
					(x + y) * LANDING_DITHER.rippleThickness +
						LANDING_DITHER.speed * LANDING_DITHER.rippleSpeed * 10
				) *
					0.08 *
					LANDING_DITHER.rippleIntensityScale +
				0.12;
			ctx.globalAlpha = Math.max(0, Math.min(0.2, fade * wave));
			ctx.fillRect(x, y, pixel, pixel);
		}
	}
	ctx.restore();
}

function hashFloat(value: number): number {
	return fract(Math.sin(value) * 43_758.5453);
}

function fract(value: number): number {
	return value - Math.floor(value);
}

function bayer2(x: number, y: number): number {
	const ax = Math.floor(x);
	const ay = Math.floor(y);
	return fract(ax / 2 + ay * ay * 0.75);
}

function bayer4(x: number, y: number): number {
	return bayer2(0.5 * x, 0.5 * y) * 0.25 + bayer2(x, y);
}

function bayer8(x: number, y: number): number {
	return bayer4(0.5 * x, 0.5 * y) * 0.25 + bayer2(x, y);
}

/** Draw the Ryu mark, centred at `cx`, `height` tall, in `color`. */
function drawLogo(
	ctx: CanvasRenderingContext2D,
	cx: number,
	topY: number,
	height: number,
	color: string
): void {
	const scale = height / 24;
	const width = 24 * scale;
	ctx.save();
	ctx.translate(cx - width / 2, topY);
	ctx.scale(scale, scale);
	const outline = new Path2D(RYU_PATH);
	ctx.strokeStyle = color;
	ctx.lineWidth = 1.5;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.stroke(outline);
	ctx.fillStyle = color;
	for (const eyeX of [15, 19]) {
		ctx.beginPath();
		ctx.ellipse(eyeX, 10, 1.5, 3, 0, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.restore();
}

/** Rasterize a scannable QR for `text`, top-left at `x,y`, `size` px square. */
function drawQr(
	ctx: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	size: number,
	color: string
): void {
	const model = qr(text);
	const cells = model.modules;
	const count = cells.length;
	if (count === 0) {
		return;
	}
	const cell = size / count;
	ctx.fillStyle = color;
	for (let r = 0; r < count; r++) {
		const row = cells[r] ?? [];
		for (let c = 0; c < count; c++) {
			if (row[c]) {
				// +0.6 overdraw removes hairline seams between modules.
				ctx.fillRect(x + c * cell, y + r * cell, cell + 0.6, cell + 0.6);
			}
		}
	}
}

function drawFront(
	ctx: CanvasRenderingContext2D,
	input: AgentBadgeInput
): void {
	const { name, role, engine, description, version, builtIn } = input;
	const hue = accentHue(engine ?? name);
	const accent = `hsl(${hue}, 72%, 52%)`;
	const cx = CARD_W / 2;
	const maxTextWidth = CARD_W - MARGIN * 2;

	fillCard(ctx, accent);

	ctx.textAlign = "center";

	// Logo mark.
	drawLogo(ctx, cx, 108, 88, INK);

	// Title (the small tracked eyebrow).
	ctx.textBaseline = "alphabetic";
	ctx.fillStyle = accent;
	ctx.font = "700 15px Inter, system-ui, sans-serif";
	const title = builtIn ? "CORE STAFF" : prettyEngine(engine);
	drawTracked(ctx, title, cx, 262, 3);

	// Agent name.
	const heading = name.trim() || "New Agent";
	const nameSize = fitFontSize(
		ctx,
		heading,
		(px) => `700 ${px}px Inter, system-ui, sans-serif`,
		46,
		26,
		maxTextWidth
	);
	ctx.font = `700 ${nameSize}px Inter, system-ui, sans-serif`;
	ctx.fillStyle = INK;
	ctx.fillText(heading, cx, 322);

	// Role / model subtitle.
	const subtitle = role?.trim() || ROLE_FALLBACK;
	ctx.font = "500 21px Inter, system-ui, sans-serif";
	ctx.fillStyle = MUTED;
	ctx.fillText(ellipsize(ctx, subtitle, maxTextWidth), cx, 358);

	// Description.
	const desc = description?.trim();
	if (desc) {
		ctx.font = "400 20px Inter, system-ui, sans-serif";
		ctx.fillStyle = FAINT;
		const lines = wrapLines(ctx, desc, maxTextWidth, 3);
		let ly = 418;
		for (const line of lines) {
			ctx.fillText(line, cx, ly);
			ly += 30;
		}
	}

	// QR code — encodes a deep link back to this agent.
	const qrSize = 168;
	const qrX = cx - qrSize / 2;
	const qrY = 560;
	drawQr(
		ctx,
		`ryu://agent/${slug(heading)}?v=${encodeURIComponent(version)}`,
		qrX,
		qrY,
		qrSize,
		INK
	);

	// Version caption under the QR.
	ctx.font = "600 14px 'JetBrains Mono', ui-monospace, monospace";
	ctx.fillStyle = FAINT;
	drawTracked(ctx, `v${version}`, cx, qrY + qrSize + 34, 1);
}

function drawBack(ctx: CanvasRenderingContext2D, input: AgentBadgeInput): void {
	const { engine, name, node, version } = input;
	const hue = accentHue(engine ?? name);
	const accent = `hsl(${hue}, 72%, 52%)`;
	const cx = CARD_W / 2;

	fillCard(ctx, accent);

	ctx.textAlign = "center";
	ctx.textBaseline = "alphabetic";

	drawLogo(ctx, cx, 150, 72, INK);

	ctx.fillStyle = FAINT;
	ctx.font = "700 14px Inter, system-ui, sans-serif";
	drawTracked(ctx, "PROPERTY OF", cx, 356, 3);

	const workspace = node?.trim() || "Ryu Workspace";
	const wsSize = fitFontSize(
		ctx,
		workspace,
		(px) => `700 ${px}px Inter, system-ui, sans-serif`,
		30,
		18,
		CARD_W - MARGIN * 2
	);
	ctx.font = `700 ${wsSize}px Inter, system-ui, sans-serif`;
	ctx.fillStyle = INK;
	ctx.fillText(workspace, cx, 398);

	ctx.fillStyle = MUTED;
	ctx.font = "400 18px Inter, system-ui, sans-serif";
	ctx.fillText("Autonomous agent operating on behalf", cx, 452);
	ctx.fillText("of the workspace above.", cx, 478);

	// Hairline + serial.
	ctx.strokeStyle = HAIRLINE;
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(MARGIN, 560);
	ctx.lineTo(CARD_W - MARGIN, 560);
	ctx.stroke();

	const serial = hashString(name + version)
		.toString(16)
		.toUpperCase()
		.padStart(8, "0");
	ctx.fillStyle = FAINT;
	ctx.font = "600 13px Inter, system-ui, sans-serif";
	drawTracked(ctx, "SERIAL", cx, 606, 3);
	ctx.fillStyle = MUTED;
	ctx.font = "500 20px 'JetBrains Mono', ui-monospace, monospace";
	ctx.fillText(`RYU-${serial}`, cx, 640);
}

/** Draw `text` with manual letter-spacing (canvas has no letterSpacing here). */
function drawTracked(
	ctx: CanvasRenderingContext2D,
	text: string,
	cx: number,
	y: number,
	tracking: number
): void {
	const widths = [...text].map((ch) => ctx.measureText(ch).width + tracking);
	const total = widths.reduce((a, b) => a + b, 0) - tracking;
	const prevAlign = ctx.textAlign;
	ctx.textAlign = "left";
	let x = cx - total / 2;
	for (let i = 0; i < text.length; i++) {
		ctx.fillText(text[i] ?? "", x, y);
		x += widths[i] ?? 0;
	}
	ctx.textAlign = prevAlign;
}

/** Trim `text` with an ellipsis so it fits `maxWidth` at the current font. */
function ellipsize(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number
): string {
	if (ctx.measureText(text).width <= maxWidth) {
		return text;
	}
	let out = text;
	while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
		out = out.slice(0, -1);
	}
	return `${out.trimEnd()}…`;
}

function newCanvas(): {
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
} | null {
	const canvas = document.createElement("canvas");
	canvas.width = CARD_W;
	canvas.height = CARD_H;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}
	return { canvas, ctx };
}

/** Build the front + back badge images for an agent as PNG data URLs. */
export function generateAgentBadge(
	input: AgentBadgeInput
): AgentBadgeImages | null {
	const front = newCanvas();
	const back = newCanvas();
	if (!(front && back)) {
		return null;
	}
	drawFront(front.ctx, input);
	drawBack(back.ctx, input);
	return {
		front: front.canvas.toDataURL("image/png"),
		back: back.canvas.toDataURL("image/png"),
	};
}
