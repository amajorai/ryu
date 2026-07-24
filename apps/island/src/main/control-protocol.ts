// Pure request-validation + port-resolution logic for the island's loopback
// control server (`control.ts`). Extracted here so the security-relevant guards
// — the CSRF / DNS-rebinding gate, the JSON content-type gate, and the
// `/ghost-cursor` body validator — can be unit-tested without pulling in
// Electron (the server wiring in `control.ts` imports `electron` + the
// ghost-cursor overlay, neither of which loads outside an Electron process).
// Mirrors the browser sidecar's `control.ts`, which split the same pure guards
// out of its HTTP server for exactly this reason.

import type { IncomingMessage } from "node:http";
import type { GhostCursorEvent } from "./ghost-cursor.ts";

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

const VALID_ACTIONS = new Set<ControlAction>([
	"toggle",
	"show",
	"hide",
	"quit",
]);

/** Narrow an untrusted body field to a known control action. */
export function isControlAction(value: unknown): value is ControlAction {
	return typeof value === "string" && VALID_ACTIONS.has(value as ControlAction);
}

const GHOST_PHASES = new Set(["move", "down", "up", "type", "scroll", "done"]);

/**
 * Validate a raw `/ghost-cursor` body into a {@link GhostCursorEvent}. The agent
 * id is not in the body — it rides the `x-ghost-agent` header (the emitting pid) —
 * so it is threaded in separately. Returns `null` when the shape is wrong.
 */
export function parseGhostCursorEvent(
	raw: string,
	agent: string
): GhostCursorEvent | null {
	let parsed: unknown;
	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") {
		return null;
	}
	const e = parsed as Record<string, unknown>;
	if (typeof e.phase !== "string" || !GHOST_PHASES.has(e.phase)) {
		return null;
	}
	if (typeof e.x !== "number" || typeof e.y !== "number") {
		return null;
	}
	return {
		seq: typeof e.seq === "number" ? e.seq : 0,
		phase: e.phase as GhostCursorEvent["phase"],
		x: e.x,
		y: e.y,
		tool: typeof e.tool === "string" ? e.tool : "",
		ts: typeof e.ts === "number" ? e.ts : 0,
		agent,
	};
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
	req: IncomingMessage,
	port: number
): boolean {
	const origin = req.headers.origin;
	if (typeof origin === "string" && origin.length > 0) {
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
export function isJsonRequest(req: IncomingMessage): boolean {
	const contentType = req.headers["content-type"] ?? "";
	return contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}
