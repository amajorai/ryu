import { appendFileSync, mkdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	isNativeBoolean,
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { z } from "zod";
import type { ProofJsonRecord } from "../../fixture-json.ts";

const root = import.meta.dirname;
const desktop = path.resolve(root, "../../..");
const proof = path.resolve(
	desktop,
	"../../docs/proof/test-coverage-sweep-20260924/parallel/coordinator-companion-page/native"
);
const token = "Bearer companion-native-proof-token";
interface CompanionCaptureControlState {
	app_allowlist: string[];
	frames: boolean;
	history_retention_days: number;
	paused: boolean;
}

const control: CompanionCaptureControlState = {
	paused: false,
	app_allowlist: [],
	frames: false,
	history_retention_days: 7,
};
const calls: unknown[] = [];
const observations: unknown[] = [];
const unknown: string[] = [];
const contractErrors: string[] = [];
async function readBody(request: IncomingMessage) {
	let raw = "";
	for await (const chunk of request) {
		raw += String(chunk);
		if (raw.length > 131_072) {
			throw new Error("Fixture request too large");
		}
	}
	return raw ? JSON.parse(raw) : null;
}
function object<RawInput>(
	value: RawInput
): value is RawInput & ProofJsonRecord {
	return z.record(z.string(), z.json()).safeParse(value).success;
}
function fixture(): Plugin {
	return {
		name: "companion-native-explicit-contracts",
		configureServer(server) {
			mkdirSync(proof, { recursive: true });
			server.middlewares.use(async (request, response, next) => {
				const url = new URL(request.url ?? "/", "http://localhost:5173");
				const key = `${request.method} ${url.pathname}`;
				const json = <FixturePayload>(status: number, body: FixturePayload) => {
					response.statusCode = status;
					response.setHeader("Content-Type", "application/json");
					response.end(JSON.stringify(body));
				};
				if (key === "GET /__companion-proof/state" && !url.search) {
					json(200, {
						boundary:
							"Real Tauri bridge, window APIs and plugin store; controlled HTTP, node identity and entitlement",
						control,
						calls,
						observations,
						unknown,
						contractErrors,
					});
					return;
				}
				if (key === "POST /__companion-proof/observation" && !url.search) {
					try {
						const body = await readBody(request);
						if (
							!object(body) ||
							body.label !== "companion" ||
							![
								"geometry",
								"geometry-error",
								"pageerror",
								"unhandledrejection",
							].includes(String(body.kind))
						) {
							throw new Error("Invalid passive observation");
						}
						const event = { at: new Date().toISOString(), ...body };
						observations.push(event);
						appendFileSync(
							path.join(proof, "native-observations.ndjson"),
							`${JSON.stringify(event)}\n`
						);
						json(200, { recorded: true });
					} catch (error) {
						contractErrors.push(String(error));
						json(400, { error: String(error) });
					}
					return;
				}
				if (!url.pathname.startsWith("/api/")) {
					next();
					return;
				}
				try {
					const body = await readBody(request);
					const call = {
						at: new Date().toISOString(),
						method: request.method,
						path: url.pathname,
						search: url.search,
						auth: request.headers.authorization ?? null,
						body,
					};
					calls.push(call);
					appendFileSync(
						path.join(proof, "native-http.ndjson"),
						`${JSON.stringify(call)}\n`
					);
					const requireContract = (condition: boolean, reason: string) => {
						if (!condition) {
							throw new Error(`${key}: ${reason}`);
						}
					};
					const supported = [
						"GET /api/agents",
						"GET /api/shadow/context/current",
						"GET /api/shadow/proactive",
						"POST /api/shadow/capture/control",
						"POST /api/chat/stream",
						"POST /api/mcp/tools/call",
					];
					if (!supported.includes(key) || url.search) {
						unknown.push(`${key}${url.search}`);
						json(501, {
							error: `Unmapped native proof contract: ${key}${url.search}`,
						});
						return;
					}
					requireContract(
						url.pathname.startsWith("/api/shadow/")
							? request.headers.authorization === undefined
							: request.headers.authorization === token,
						"unexpected authorization"
					);
					if (request.method === "GET") {
						requireContract(body === null, "GET body must be absent");
					} else {
						requireContract(
							request.headers["content-type"]?.includes("application/json") ===
								true,
							"JSON content type required"
						);
					}
					switch (key) {
						case "GET /api/agents":
							json(200, {
								agents: [{ id: "agent-native-proof", name: "Companion Agent" }],
							});
							return;
						case "GET /api/shadow/context/current":
							json(200, {
								active_app: control.paused ? null : "Finder",
								window_title: control.paused ? null : "Documents",
								selected_text: control.paused ? null : "Quarterly report",
								screen_text: control.paused ? null : "Quarterly report",
								paused: control.paused,
							});
							return;
						case "GET /api/shadow/proactive":
							json(200, { suggestions: [] });
							return;
						case "POST /api/shadow/capture/control": {
							requireContract(object(body), "capture update must be object");
							if (!object(body)) {
								return;
							}
							requireContract(
								Object.keys(body).length > 0 &&
									Object.keys(body).every((field) =>
										[
											"paused",
											"app_allowlist",
											"frames",
											"history_retention_days",
										].includes(field)
									),
								"unknown capture field"
							);
							if ("paused" in body) {
								requireContract(isNativeBoolean(body.paused), "invalid paused");
							}
							if ("frames" in body) {
								requireContract(isNativeBoolean(body.frames), "invalid frames");
							}
							if ("app_allowlist" in body) {
								requireContract(
									Array.isArray(body.app_allowlist) &&
										body.app_allowlist.every(isNativeText),
									"invalid allowlist"
								);
							}
							if ("history_retention_days" in body) {
								requireContract(
									isNativeNumber(body.history_retention_days) &&
										Number.isFinite(body.history_retention_days) &&
										body.history_retention_days >= 0,
									"invalid retention"
								);
							}
							Object.assign(control, body);
							json(200, control);
							return;
						}
						case "POST /api/chat/stream": {
							requireContract(object(body), "chat must be object");
							if (!object(body)) {
								return;
							}
							requireContract(
								Object.keys(body).sort().join(",") ===
									"companion_source,conversation_id,enable_long_term,messages,response_mode",
								"chat field drift"
							);
							requireContract(
								body.companion_source === true &&
									body.enable_long_term === false &&
									isNativeText(body.conversation_id) &&
									/^companion-[0-9a-f-]{36}$/.test(body.conversation_id),
								"invalid Companion chat flags/id"
							);
							requireContract(
								Array.isArray(body.messages) &&
									body.messages.length === 1 &&
									object(body.messages[0]) &&
									body.messages[0].role === "user" &&
									isNativeText(body.messages[0].content),
								"invalid message"
							);
							requireContract(
								["everyday", "developer"].includes(String(body.response_mode)),
								"invalid response mode"
							);
							// Core's UI-message SSE framing (sidecar/adapters `ui_chunk`).
							response.setHeader("Content-Type", "text/event-stream");
							response.setHeader("x-vercel-ai-ui-message-stream", "v1");
							response.end(
								`${[
									{ type: "start" },
									{ id: "t1", type: "text-start" },
									{
										delta: "The report explains quarterly results.",
										id: "t1",
										type: "text-delta",
									},
									{ id: "t1", type: "text-end" },
									{ type: "finish" },
								]
									.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
									.join("")}data: [DONE]\n\n`
							);
							return;
						}
						case "POST /api/mcp/tools/call": {
							requireContract(object(body), "MCP must be object");
							if (!object(body)) {
								return;
							}
							requireContract(
								Object.keys(body).sort().join(",") ===
									"agent_id,arguments,tool" &&
									body.agent_id === "agent-native-proof",
								"MCP agent/field drift"
							);
							const expected =
								body.tool === "ghost.ghost_focus"
									? { app: "Finder" }
									: body.tool === "ghost.ghost_screenshot"
										? {}
										: body.tool === "ghost.ghost_click"
											? { query: "Documents" }
											: null;
							requireContract(
								expected !== null &&
									JSON.stringify(body.arguments) === JSON.stringify(expected),
								"unexpected Ghost action/target"
							);
							json(200, {
								ok: true,
								output:
									body.tool === "ghost.ghost_focus" ? "Focused Finder" : null,
							});
							return;
						}
					}
				} catch (error) {
					contractErrors.push(String(error));
					appendFileSync(
						path.join(proof, "native-contract-errors.ndjson"),
						`${JSON.stringify({ at: new Date().toISOString(), error: String(error) })}\n`
					);
					json(400, { error: String(error) });
				}
			});
		},
	};
}
export default defineConfig({
	root,
	publicDir: path.resolve(desktop, "public"),
	cacheDir: `${tmpdir()}/ryu-companion-native-proof-vite`,
	plugins: [react(), fixture()],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["index.html"],
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			...[
				"./components/layout/Layout.tsx",
				"./components/bot/BotManagedEntry.tsx",
				"./components/shell/GlobalContextMenu.tsx",
				"./components/startup/DesktopStartupChooser.tsx",
				"./components/media/MediaPip.tsx",
				"./components/AgentationToolbar.tsx",
				"./pages/HostedStandaloneAppEntry.tsx",
				"./pages/LoginPage.tsx",
				"./pages/OnboardingPage.tsx",
				"./pages/StandaloneAppEntry.tsx",
				"./pages/WaitlistPage.tsx",
			].map((find) => ({
				find,
				replacement: path.resolve(
					root,
					"../companion-page-inactive-surfaces.fixture.tsx"
				),
			})),
			...[
				"@/src/hooks/useActiveNode.ts",
				"@/src/hooks/useEntitlement.ts",
				"@/lib/core-url.ts",
			].map((find) => ({
				find,
				replacement: path.resolve(root, "controlled-node.ts"),
			})),
			{ find: "@", replacement: desktop },
			{
				find: "react",
				replacement: path.resolve(desktop, "node_modules/react"),
			},
			{
				find: "react-dom",
				replacement: path.resolve(desktop, "node_modules/react-dom"),
			},
		],
	},
	server: { host: "localhost", port: 5173, strictPort: true },
});
