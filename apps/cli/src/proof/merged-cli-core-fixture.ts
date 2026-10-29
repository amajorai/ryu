// Strict loopback Core fixture for the real merged CLI in a native terminal.
// This is fixture/provider proof; it never claims live Core or model execution.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inspectCliFixtureRequest } from "./cli-fixture-auth.ts";
import {
	type FixtureJson,
	type FixtureRecord,
	mergedBodyFields,
	mergedFixtureCancelSchema,
	mergedFixtureChatSchema,
	parseFixtureJson,
} from "./cli-fixture-contract.ts";

const { values } = parseArgs({
	options: {
		port: { type: "string" },
		"proof-dir": { type: "string" },
		token: { type: "string" },
	},
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
	throw new Error("Pass an explicit unprivileged --port");
}
if (!(values["proof-dir"] && isAbsolute(values["proof-dir"]))) {
	throw new Error("Pass a fresh absolute --proof-dir");
}
if (!values.token?.startsWith("fixture-")) {
	throw new Error("Pass a synthetic --token starting with fixture-");
}
const token = values.token;
const proofDir = resolve(values["proof-dir"]);
mkdirSync(proofDir, { recursive: false });
const cliConfigDir = join(proofDir, "cli-config");
mkdirSync(cliConfigDir, { recursive: false });
const origin = `http://127.0.0.1:${port}`;
writeFileSync(
	join(cliConfigDir, "nodes.json"),
	JSON.stringify(
		{
			default: "merged-cli-proof",
			nodes: [{ name: "merged-cli-proof", url: origin, token: null }],
		},
		null,
		2
	)
);
writeFileSync(
	join(cliConfigDir, "cli-product-mode.json"),
	JSON.stringify(
		{
			version: 1,
			mode: "console",
			startupRealm: "last-used",
			surfaces: { console: "/chat", bot: "/chat", os: "/app-launcher" },
		},
		null,
		2
	)
);
writeFileSync(join(cliConfigDir, "prompt-history.json"), "[]\n");
writeFileSync(
	join(cliConfigDir, "cli-memory.json"),
	JSON.stringify({ version: 1, enableLongTerm: false })
);
const logPath = join(proofDir, "requests.jsonl");
const state = {
	requests: 0,
	rejected: 0,
	advertised: false,
	commandAttempts: 0,
	replacement: false,
	cleared: false,
	heldStarted: false,
	heldCancelled: false,
	cancelRequested: false,
	resumed: false,
};
let conversationId: string | null = null;
let shutdownHeld: (() => void) | null = null;
function record(event: FixtureRecord) {
	appendFileSync(
		logPath,
		`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`
	);
}
function refuse(reason: string): Response {
	state.rejected += 1;
	record({ event: "refused", reason });
	return Response.json(
		{ error: `Strict CLI fixture refused: ${reason}` },
		{ status: 422 }
	);
}
const reads = new Map<string, FixtureJson>([
	["/api/health", { status: "ok" }],
	["/api/auth/status", { authenticated: false, token: null }],
	// The actual CLI warms its local identity broker before mounting the TUI.
	// This fixture intentionally has no account session, so the exchange must
	// complete with no delegated JWT and must not borrow ambient credentials.
	["/api/auth/user-jwt", { token: null }],
	["/api/auth/accounts", { activeUserId: null, accounts: [] }],
	[
		"/api/update/check",
		{
			current: "0.4.0",
			latest: "0.4.0",
			update_available: false,
			html_url: null,
		},
	],
	[
		"/api/preferences/auto-updates",
		{ key: "auto-updates", value: JSON.stringify({ enabled: false }) },
	],
	[
		"/api/preferences/terminal-theme",
		{ key: "terminal-theme", value: JSON.stringify("dark") },
	],
	["/api/preferences/theme", { key: "theme", value: JSON.stringify("dark") }],
	["/api/plugins", { apps: [] }],
	["/api/plugins/contributions", { views: [], slash_commands: [] }],
	["/api/agents", { agents: [{ id: "agent-reviewer", name: "Review Agent" }] }],
	["/api/teams", { teams: [] }],
	["/api/spaces", { spaces: [] }],
	["/api/meetings", { meetings: [] }],
	["/api/conversations", { conversations: [] }],
	["/workflows", { workflows: [] }],
	[
		"/api/agents/agent-reviewer/acp-config",
		{ modes: null, models: null, configOptions: [] },
	],
]);
function promptFromBody(input: FixtureJson): string | null {
	const parsed = mergedFixtureChatSchema.safeParse(input);
	if (
		!parsed.success ||
		Object.keys(input ?? {}).some((key) => !mergedBodyFields.has(key))
	) {
		return null;
	}
	const body = parsed.data;
	const last = body.messages.at(-1);
	if (last?.role !== "user") {
		return null;
	}
	if (conversationId !== null && conversationId !== body.conversation_id) {
		return null;
	}
	conversationId = body.conversation_id;
	return last.content[0].text;
}
/**
 * The CLI's Stop also asks Core to cancel the persisted turn (Core keeps it
 * running after the stream is aborted). Accept exactly one cancel, for the held
 * turn's conversation, before the same-conversation retry.
 */
function cancelHeldTurn(input: FixtureJson): Response {
	const parsed = mergedFixtureCancelSchema.safeParse(input);
	if (
		!parsed.success ||
		parsed.data.conversation_id !== conversationId ||
		!state.heldStarted ||
		state.cancelRequested ||
		state.resumed
	) {
		return refuse("Expected one cancel for the held turn's conversation");
	}
	state.cancelRequested = true;
	record({ event: "held-turn-cancel-requested", conversationMatches: true });
	return Response.json({ cancelled: true });
}
const encoder = new TextEncoder();
function sse(events: FixtureJson[]): Response {
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } }
	);
}
function commands(name: string | null) {
	return {
		type: "data-ryu-acp-commands",
		data: {
			commands: name
				? [
						{
							name,
							description: `Run ${name} using Review Agent.`,
							hint: "changes",
						},
					]
				: [],
		},
	};
}
function finished(text: string, command: string | null): Response {
	return sse([
		{ type: "text-delta", delta: text },
		commands(command),
		{ type: "finish" },
	]);
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port,
	idleTimeout: 255,
	async fetch(request) {
		const url = new URL(request.url);
		state.requests += 1;
		let body: FixtureJson = null;
		const raw = await request.text();
		if (raw) {
			try {
				body = parseFixtureJson(raw);
			} catch {
				return refuse("Malformed request JSON");
			}
		}
		const requestInspection = inspectCliFixtureRequest(
			request,
			origin,
			token,
			body
		);
		const { trace } = requestInspection;
		record({ event: "request", ...trace });
		if (!requestInspection.authorized) {
			return refuse(
				"Origin/query/node authorization/delegated identity mismatch"
			);
		}
		if (request.method === "GET" && raw === "" && reads.has(url.pathname)) {
			return Response.json(reads.get(url.pathname));
		}
		if (
			request.method === "POST" &&
			url.pathname === "/api/chat/cancel" &&
			request.headers.get("content-type")?.split(";", 1)[0] ===
				"application/json"
		) {
			return cancelHeldTurn(body);
		}
		if (
			request.method !== "POST" ||
			url.pathname !== "/api/chat/stream" ||
			request.headers.get("content-type")?.split(";", 1)[0] !==
				"application/json"
		) {
			return refuse("Unknown method, route or request content type");
		}
		const prompt = promptFromBody(body);
		if (prompt === null) {
			return refuse(
				"Expected exact Review Agent conversation/text routing and supported body keys"
			);
		}
		if (prompt === "advertise commands" && !state.advertised) {
			state.advertised = true;
			return finished("ACP command ready.", "acp-review");
		}
		if (
			prompt === "/acp-review check staged changes" &&
			state.advertised &&
			state.commandAttempts < 2
		) {
			state.commandAttempts += 1;
			if (state.commandAttempts === 1) {
				return new Response("temporary ACP route failure", { status: 503 });
			}
			state.replacement = true;
			return finished("Review complete. Commands replaced.", "acp-followup");
		}
		if (prompt === "clear commands" && state.replacement && !state.cleared) {
			state.cleared = true;
			return finished("ACP commands cleared.", null);
		}
		if (prompt === "hold stream" && state.cleared && !state.heldStarted) {
			state.heldStarted = true;
			let timeout: ReturnType<typeof setTimeout> | null = null;
			let heartbeat: ReturnType<typeof setInterval> | null = null;
			let settled = false;
			const cleanup = () => {
				if (timeout) {
					clearTimeout(timeout);
				}
				if (heartbeat) {
					clearInterval(heartbeat);
				}
				request.signal.removeEventListener("abort", cancelled);
				shutdownHeld = null;
			};
			const cancelled = () => {
				if (settled) {
					return;
				}
				settled = true;
				state.heldCancelled = true;
				record({
					event: "held-stream-cancelled",
					conversationIdPresent: conversationId !== null,
				});
				cleanup();
			};
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: "text-delta", delta: "Held stream active; queue then clear and press Escape." })}\n\n`
						)
					);
					request.signal.addEventListener("abort", cancelled, { once: true });
					heartbeat = setInterval(() => {
						if (settled) {
							return;
						}
						try {
							controller.enqueue(encoder.encode(": keepalive\n\n"));
						} catch {
							cancelled();
						}
					}, 1000);
					timeout = setTimeout(() => {
						if (settled) {
							return;
						}
						settled = true;
						cleanup();
						state.rejected += 1;
						record({
							event: "held-stream-timeout",
							reason: "No observed client Stop within 180 seconds",
						});
						controller.close();
					}, 180_000);
					shutdownHeld = () => {
						if (!settled) {
							settled = true;
							cleanup();
							controller.close();
						}
					};
					if (request.signal.aborted) {
						cancelled();
					}
				},
				cancel: cancelled,
			});
			return new Response(stream, {
				headers: { "content-type": "text/event-stream" },
			});
		}
		if (
			prompt === "after stop" &&
			state.heldCancelled &&
			state.cancelRequested &&
			!state.resumed
		) {
			state.resumed = true;
			return finished("Same-conversation retry completed after Stop.", null);
		}
		return refuse("Unexpected prompt or scenario order");
	},
});
writeFileSync(
	join(proofDir, "launch.json"),
	JSON.stringify(
		{
			pid: process.pid,
			origin,
			nodeAuthority: "synthetic fixture token; redacted",
			cliConfigDir,
			data: join(proofDir, "data"),
			source: import.meta.path,
		},
		null,
		2
	)
);
record({ event: "fixture-ready", pid: process.pid, origin });
function stop() {
	shutdownHeld?.();
	const complete =
		state.rejected === 0 &&
		state.advertised &&
		state.commandAttempts === 2 &&
		state.replacement &&
		state.cleared &&
		state.heldStarted &&
		state.heldCancelled &&
		state.cancelRequested &&
		state.resumed;
	writeFileSync(
		join(proofDir, "summary.json"),
		JSON.stringify(
			{
				...state,
				conversationIdPresent: conversationId !== null,
				complete,
				boundary:
					"Real CLI/native terminal with strict synthetic Core; live provider behavior unverified",
			},
			null,
			2
		)
	);
	server.stop(true);
	process.exit(complete ? 0 : 1);
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
