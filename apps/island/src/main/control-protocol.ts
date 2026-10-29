// Pure request-validation + port-resolution logic for the island's loopback
// control server (`control.ts`). Extracted here so the security-relevant guards
// — the CSRF / DNS-rebinding gate, the JSON content-type gate, and the
// `/ghost-cursor` body validator — can be unit-tested without pulling in
// Electron (the server wiring in `control.ts` imports `electron` + the
// ghost-cursor overlay, neither of which loads outside an Electron process).
// Mirrors the browser sidecar's `control.ts`, which split the same pure guards
// out of its HTTP server for exactly this reason.

import type { IncomingMessage } from "node:http";
import { z } from "zod";

export type GhostCursorPhase =
	| "move"
	| "down"
	| "up"
	| "type"
	| "scroll"
	| "done";

export interface GhostCursorEvent {
	agent: string;
	identity?: GhostCursorIdentity;
	intent: string;
	phase: GhostCursorPhase;
	seq: number;
	tool: string;
	ts: number;
	x: number;
	y: number;
}

export interface GhostCursorIdentity {
	agentId?: string;
	agentName?: string;
	agentTitle?: string;
	avatarEmoji?: string;
	avatarUrl?: string;
	sessionTitle?: string;
}

/** Base loopback port the desktop tray dials (kept distinct from Core/Shadow). */
export const ISLAND_CONTROL_BASE_PORT = 7989;
/** Dev-profile port shift so a dev island runs alongside a release island. */
export const DEV_PORT_OFFSET = 1000;

/**
 * Resolve the loopback control port. An explicit `ISLAND_CONTROL_PORT` env var
 * wins (so `bun run dev` can pin both sides at once); else `RYU_PROFILE=dev`
 * shifts the base by +1000; else the base. Takes the env as a parameter so the
 * resolution is testable without mutating `process.env`.
 */
export function resolveControlPort(
	env: NodeJS.ProcessEnv = process.env
): number {
	const explicit = Number.parseInt(env.ISLAND_CONTROL_PORT ?? "", 10);
	if (Number.isInteger(explicit) && explicit > 0) {
		return explicit;
	}
	const isDev = (env.RYU_PROFILE ?? "").trim().toLowerCase() === "dev";
	return isDev
		? ISLAND_CONTROL_BASE_PORT + DEV_PORT_OFFSET
		: ISLAND_CONTROL_BASE_PORT;
}

/** Window/lifecycle actions the desktop tray can drive over the loopback POST. */
export type ControlAction = "toggle" | "show" | "hide" | "quit";

const controlActionSchema = z.enum(["toggle", "show", "hide", "quit"]);

/** Narrow an untrusted body field to a known control action. */
export function isControlAction(
	value: Parameters<typeof controlActionSchema.safeParse>[0]
): value is ControlAction {
	return controlActionSchema.safeParse(value).success;
}

const ghostPhaseSchema = z.enum([
	"move",
	"down",
	"up",
	"type",
	"scroll",
	"done",
]);

const MAX_GHOST_INTENT_LENGTH = 72;
const MAX_CURSOR_TITLE_LENGTH = 160;
const MAX_CURSOR_AGENT_LENGTH = 80;
const MAX_CURSOR_AVATAR_URL_LENGTH = 20_000;

function boundedTextSchema(limit: number) {
	return z
		.string()
		.trim()
		.min(1)
		.transform((value) => Array.from(value).slice(0, limit).join(""))
		.optional()
		.catch(undefined);
}

function safeAvatarUrl(value: string): string | undefined {
	const url = value.trim();
	if (!url || url.length > MAX_CURSOR_AVATAR_URL_LENGTH) {
		return;
	}
	if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(url)) {
		return url;
	}
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "https:" || parsed.protocol === "http:") {
			return url;
		}
	} catch {
		return;
	}
}

const cursorIdentitySchema = z
	.object({
		agentId: boundedTextSchema(96),
		agentName: boundedTextSchema(MAX_CURSOR_AGENT_LENGTH),
		agentTitle: boundedTextSchema(MAX_CURSOR_AGENT_LENGTH),
		sessionTitle: boundedTextSchema(MAX_CURSOR_TITLE_LENGTH),
		avatarUrl: z.string().transform(safeAvatarUrl).optional().catch(undefined),
		avatarEmoji: boundedTextSchema(8),
	})
	.transform((identity) =>
		Object.values(identity).some(Boolean) ? identity : undefined
	)
	.optional()
	.catch(undefined);

/** Stable display hue per agent, independent of the short-lived Ghost process id. */
export function ghostCursorHueFor(
	identity: GhostCursorIdentity | undefined,
	fallbackAgent = "0"
): number {
	const seed =
		identity?.agentId ||
		identity?.agentName ||
		identity?.sessionTitle ||
		fallbackAgent ||
		"0";
	let hash = 0;
	for (let index = 0; index < seed.length; index += 1) {
		hash = (hash * 31 + seed.charCodeAt(index)) | 0;
	}
	return Math.abs(hash) % 360;
}

/** Give older Ghost sidecars a useful label while they roll forward. */
export function defaultGhostIntent(
	phase: GhostCursorPhase,
	tool: string
): string {
	if (tool === "ghost_click") {
		return "Clicking";
	}
	if (tool === "ghost_type") {
		return "Typing";
	}
	if (tool === "ghost_scroll") {
		return "Scrolling";
	}
	if (tool === "ghost_drag") {
		return "Dragging";
	}
	if (tool === "ghost_hover") {
		return "Hovering";
	}
	if (tool === "ghost_long_press") {
		return "Holding";
	}
	if (phase === "done") {
		return "Done";
	}
	return "Working";
}

function normalizeGhostIntent(
	value: string,
	phase: GhostCursorPhase,
	tool: string
): string {
	const intent = value.trim();
	if (!intent) {
		return defaultGhostIntent(phase, tool);
	}
	if (intent.length <= MAX_GHOST_INTENT_LENGTH) {
		return intent;
	}
	return `${intent.slice(0, MAX_GHOST_INTENT_LENGTH - 1).trimEnd()}…`;
}

const ghostCursorBodySchema = z.object({
	phase: ghostPhaseSchema,
	x: z.number(),
	y: z.number(),
	tool: z.string().catch(""),
	intent: z.string().catch(""),
	identity: cursorIdentitySchema,
	seq: z.number().catch(0),
	ts: z.number().catch(0),
});

/** Validate a raw `/ghost-cursor` body before displaying the cursor. */
export function parseGhostCursorEvent(
	raw: string,
	agent: string
): GhostCursorEvent | null {
	try {
		const parsed = ghostCursorBodySchema.safeParse(
			raw ? JSON.parse(raw) : null
		);
		if (!parsed.success) {
			return null;
		}
		const event = parsed.data;
		const { identity, ...fields } = event;
		const result: GhostCursorEvent = {
			...fields,
			agent,
			intent: normalizeGhostIntent(event.intent, event.phase, event.tool),
		};
		if (identity) {
			result.identity = identity;
		}
		return result;
	} catch {
		return null;
	}
}

/**
 * Guard the loopback server against drive-by browser requests (CSRF) and
 * DNS rebinding. Browsers attach an `Origin` header to every cross-origin
 * request they issue — including CORS-safelisted `text/plain` POSTs that skip
 * preflight, and no-JS `<form enctype="text/plain">` submissions — while the
 * legitimate local callers (the desktop tray's reqwest client, the Ghost
 * sidecar's raw loopback POST) send none. Any non-empty `Origin` is therefore
 * hostile. The `Host` header must also name this exact loopback endpoint: a
 * DNS-rebound page reaches us with `Host: attacker.example`, so anything but
 * our own address:port is rejected.
 */
export function isTrustedLocalRequest(
	req: Pick<IncomingMessage, "headers">,
	port: number
): boolean {
	const origin = req.headers.origin;
	if (origin && origin.length > 0) {
		return false;
	}
	const host = req.headers.host;
	return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * Whether a request declares a JSON body. Both local callers send
 * `application/json`; browser "simple requests" that dodge CORS preflight
 * cannot. Belt-and-suspenders on top of the Origin check: bodies are only
 * parsed as JSON when they claim to be JSON.
 */
export function isJsonRequest(req: Pick<IncomingMessage, "headers">): boolean {
	const contentType = req.headers["content-type"] ?? "";
	return contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}
