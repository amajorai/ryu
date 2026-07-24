// Loopback control server for the Ryu Island.
//
// The island has no Dock icon (`LSUIElement`) and — since the menu-bar presence
// was unified under the desktop (Tauri) tray — no tray of its own. To stay
// controllable, it exposes a tiny HTTP server bound to loopback only. The desktop
// tray ("Show/Hide Companion", "Quit") drives the island through this surface,
// mirroring how the island itself talks to Core/Shadow over local HTTP.
//
// Bound to 127.0.0.1 exclusively: no remote origin can reach it, matching the
// Shadow sidecar's loopback-only posture. Loopback alone does not stop the
// user's browser from being used as a confused deputy, so every request is
// additionally gated by `isTrustedLocalRequest` (no `Origin` header, exact
// loopback `Host`) and POST bodies must declare `application/json`.
// Capture pause/resume is NOT handled
// here — that is a Shadow concern (`/capture/control` on :3030) the desktop calls
// directly. This server only owns the island's own window + lifecycle.

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { app } from "electron";
import {
	type ControlAction,
	isControlAction,
	isJsonRequest,
	isTrustedLocalRequest,
	parseGhostCursorEvent,
	resolveControlPort,
} from "./control-protocol.ts";
import { pushGhostCursorEvent } from "./ghost-cursor.ts";
import {
	hideWindow,
	isVisible,
	showWindow,
	toggleWindow,
} from "./visibility.ts";

/**
 * Loopback port the desktop tray dials. Kept distinct from Core (:7980) and
 * Shadow (:3030). Profile-aware so a dev island runs ALONGSIDE a release island
 * without both binding the same port: an explicit `ISLAND_CONTROL_PORT` env var
 * wins (so `bun run dev` can set both sides at once), else `RYU_PROFILE=dev`
 * shifts the base by +1000 (→ 8989), matching the desktop tray dialer's
 * `profile::island_control_port()` in `desktop/src-tauri/src/tray.rs`. The pure
 * resolution + request guards live in {@link ./control-protocol.ts} so they can
 * be tested without Electron.
 */
export const ISLAND_CONTROL_PORT = resolveControlPort();

let server: Server | null = null;

function applyAction(action: ControlAction): void {
	switch (action) {
		case "toggle":
			toggleWindow();
			break;
		case "show":
			showWindow();
			break;
		case "hide":
			hideWindow();
			break;
		case "quit":
			// Defer so the HTTP response flushes before the process tears down.
			setImmediate(() => app.quit());
			break;
		default:
			break;
	}
}

function rejectForbidden(res: ServerResponse): void {
	res.writeHead(403, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: false, error: "forbidden" }));
}

function rejectNonJson(res: ServerResponse): void {
	res.writeHead(415, { "Content-Type": "application/json" });
	res.end(
		JSON.stringify({ ok: false, error: "application/json body required" })
	);
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Start the loopback control server. Best-effort: if the port is already bound
 * (e.g. a stale instance), log and continue rather than crashing the island —
 * the global hotkey still works as a fallback summon.
 */
export function startControlServer(): void {
	if (server) {
		return;
	}
	server = createServer((req, res) => {
		// Loopback-only is not enough: any web page can POST here (CSRF via
		// CORS-safelisted content types) and a DNS-rebound page can read state.
		// Reject anything that is not a plain local-process request.
		if (!isTrustedLocalRequest(req, ISLAND_CONTROL_PORT)) {
			rejectForbidden(res);
			return;
		}
		// GET /control → current visibility, so the desktop can label its menu.
		if (req.method === "GET" && req.url === "/control") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ visible: isVisible() }));
			return;
		}
		if (req.method === "POST" && req.url === "/control") {
			if (!isJsonRequest(req)) {
				rejectNonJson(res);
				return;
			}
			readBody(req)
				.then((raw) => {
					const parsed = raw ? (JSON.parse(raw) as { action?: unknown }) : {};
					if (!isControlAction(parsed.action)) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: false, error: "invalid action" }));
						return;
					}
					applyAction(parsed.action);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true, visible: isVisible() }));
				})
				.catch(() => {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: "bad request" }));
				});
			return;
		}
		// POST /ghost-cursor → drive the visible ghost-cursor overlay. Same
		// loopback-only posture as /control (the server binds 127.0.0.1). The
		// emitting Ghost agent's pid rides the x-ghost-agent header (per-agent hue).
		if (req.method === "POST" && req.url === "/ghost-cursor") {
			if (!isJsonRequest(req)) {
				rejectNonJson(res);
				return;
			}
			const agentHeader = req.headers["x-ghost-agent"];
			const agent = Array.isArray(agentHeader)
				? (agentHeader[0] ?? "0")
				: (agentHeader ?? "0");
			readBody(req)
				.then((raw) => {
					const event = parseGhostCursorEvent(raw, agent);
					if (!event) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: false, error: "invalid event" }));
						return;
					}
					pushGhostCursorEvent(event);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: true }));
				})
				.catch(() => {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ ok: false, error: "bad request" }));
				});
			return;
		}
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: false, error: "not found" }));
	});
	server.on("error", (err) => {
		// Port in use or other bind failure: degrade to hotkey-only control.
		// biome-ignore lint/suspicious/noConsole: main-process diagnostic, no renderer.
		console.warn(`[island] control server unavailable: ${err.message}`);
		server = null;
	});
	server.listen(ISLAND_CONTROL_PORT, "127.0.0.1");
}

/** Stop the control server (called on quit). */
export function stopControlServer(): void {
	server?.close();
	server = null;
}
