// apps/desktop/src/lib/agent-badge.ts
//
// Renders a minimal, Apple-style "employee card" for an agent — the face that
// gets composited onto the Lanyard badge (see AgentLanyardCard). We draw to an
// offscreen canvas and return data URLs rather than mounting DOM: deterministic
// and safe to feed straight into the WebGL texture
// (same-origin canvas, never tainted).
//
// Design: a clean white ID card — the Ryu logo mark up top, a small tracked
// title, the agent's name, a short description, and a scannable QR code. One
// accent hue is derived from the agent so each card is subtly its own, but the
// card stays quiet and monochrome everywhere else.

import {
	drawLandingDither,
	drawLogo,
	drawQr,
	drawTracked,
	ellipsize,
	fitFontSize,
	wrapLines,
} from "./agent-badge-paint.ts";

export interface AgentBadgeInput {
	/** Built-in agents get a "Core staff" eyebrow instead of the engine. */
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

/**
 * The card's printed words, in the UI language. Callers pass `tl()`-resolved
 * copy; English is the default so tests and pre-provider paints stay stable.
 * Eyebrows are written in sentence case and upper-cased with `locale`, which
 * leaves scripts without case (Japanese, Arabic) as written.
 */
export interface AgentBadgeLabels {
	/** Eyebrow when the engine is unknown. */
	agent: string;
	/** Eyebrow for built-in agents. */
	coreStaff: string;
	/** BCP 47 tag the card is painted in; sets case mapping and direction. */
	locale: string;
	/** Headline when the agent has no name yet. */
	newAgent: string;
	/** The back's sentence under the workspace name. */
	onBehalf: string;
	/** The back's eyebrow over the workspace name. */
	propertyOf: string;
	/** Subtitle when the agent has no role. */
	roleFallback: string;
	/** Text direction of `locale`. */
	rtl: boolean;
	/** The back's eyebrow over the serial number. */
	serial: string;
	/** Workspace name when none is known. */
	workspaceFallback: string;
}

export const ENGLISH_AGENT_BADGE_LABELS: AgentBadgeLabels = {
	agent: "Agent",
	coreStaff: "Core staff",
	locale: "en",
	newAgent: "New Agent",
	onBehalf: "Autonomous agent operating on behalf of the workspace above.",
	propertyOf: "Property of",
	roleFallback: "Autonomous Agent",
	rtl: false,
	serial: "Serial",
	workspaceFallback: "Ryu Workspace",
};

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

const RE_ENGINE_SPLIT = /[:/]/;
const RE_SEPARATORS = /[-_]/g;
const RE_NON_ALNUM = /[^a-z0-9]+/g;
const RE_EDGE_DASHES = /^-+|-+$/g;

function hashString(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		// standard 32-bit string hash
		hash = (Math.imul(hash, 31) + value.charCodeAt(i)) >>> 0;
	}
	return hash;
}

function accentHue(seed: string): number {
	return hashString(seed || "ryu") % 360;
}

function eyebrow(text: string, labels: AgentBadgeLabels): string {
	try {
		return text.toLocaleUpperCase(labels.locale);
	} catch {
		return text.toUpperCase();
	}
}

function prettyEngine(engine: string | null, labels: AgentBadgeLabels): string {
	if (!engine) {
		return eyebrow(labels.agent, labels);
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

function fillCard(ctx: CanvasRenderingContext2D, accent: string): void {
	const bg = ctx.createLinearGradient(0, 0, 0, CARD_H);
	bg.addColorStop(0, CARD_TOP);
	bg.addColorStop(1, CARD_BOTTOM);
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, CARD_W, CARD_H);
	drawLandingDither(ctx, CARD_W, CARD_H);
	// A single thin accent bar at the very top is the only colour on the card.
	ctx.fillStyle = accent;
	ctx.fillRect(0, 0, CARD_W, 5);
}

function drawFront(
	ctx: CanvasRenderingContext2D,
	input: AgentBadgeInput,
	labels: AgentBadgeLabels
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
	ctx.font = "500 15px Inter, system-ui, sans-serif";
	const title = builtIn
		? eyebrow(labels.coreStaff, labels)
		: prettyEngine(engine, labels);
	drawTracked(ctx, title, cx, 262, 3);

	// Agent name.
	const heading = name.trim() || labels.newAgent;
	const nameSize = fitFontSize(
		ctx,
		heading,
		(px) => `500 ${px}px Inter, system-ui, sans-serif`,
		46,
		26,
		maxTextWidth
	);
	ctx.font = `500 ${nameSize}px Inter, system-ui, sans-serif`;
	ctx.fillStyle = INK;
	ctx.fillText(heading, cx, 322);

	// Role / model subtitle.
	const subtitle = role?.trim() || labels.roleFallback;
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
	ctx.font = "500 14px Inter, system-ui, sans-serif";
	ctx.fillStyle = FAINT;
	drawTracked(ctx, `v${version}`, cx, qrY + qrSize + 34, 1);
}

function drawBack(
	ctx: CanvasRenderingContext2D,
	input: AgentBadgeInput,
	labels: AgentBadgeLabels
): void {
	const { engine, name, node, version } = input;
	const hue = accentHue(engine ?? name);
	const accent = `hsl(${hue}, 72%, 52%)`;
	const cx = CARD_W / 2;

	fillCard(ctx, accent);

	ctx.textAlign = "center";
	ctx.textBaseline = "alphabetic";

	drawLogo(ctx, cx, 150, 72, INK);

	ctx.fillStyle = FAINT;
	ctx.font = "500 14px Inter, system-ui, sans-serif";
	drawTracked(ctx, eyebrow(labels.propertyOf, labels), cx, 356, 3);

	const workspace = node?.trim() || labels.workspaceFallback;
	const wsSize = fitFontSize(
		ctx,
		workspace,
		(px) => `500 ${px}px Inter, system-ui, sans-serif`,
		30,
		18,
		CARD_W - MARGIN * 2
	);
	ctx.font = `500 ${wsSize}px Inter, system-ui, sans-serif`;
	ctx.fillStyle = INK;
	ctx.fillText(workspace, cx, 398);

	ctx.fillStyle = MUTED;
	ctx.font = "400 18px Inter, system-ui, sans-serif";
	let line = 452;
	for (const text of wrapLines(ctx, labels.onBehalf, CARD_W - MARGIN * 2, 2)) {
		ctx.fillText(text, cx, line);
		line += 26;
	}

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
	ctx.font = "500 13px Inter, system-ui, sans-serif";
	drawTracked(ctx, eyebrow(labels.serial, labels), cx, 606, 3);
	ctx.fillStyle = MUTED;
	ctx.font = "500 20px Inter, system-ui, sans-serif";
	ctx.fillText(`RYU-${serial}`, cx, 640);
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
	input: AgentBadgeInput,
	labels: AgentBadgeLabels = ENGLISH_AGENT_BADGE_LABELS
): AgentBadgeImages | null {
	const front = newCanvas();
	const back = newCanvas();
	if (!(front && back)) {
		return null;
	}
	for (const { ctx } of [front, back]) {
		ctx.direction = labels.rtl ? "rtl" : "ltr";
	}
	drawFront(front.ctx, input, labels);
	drawBack(back.ctx, input, labels);
	return {
		front: front.canvas.toDataURL("image/png"),
		back: back.canvas.toDataURL("image/png"),
	};
}
