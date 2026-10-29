/**
 * Ryu MCP bridge — a Pi extension for the flagship, managed "ryu" (Pi) agent.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every non-Pi ACP agent reaches Ryu's registered tools through Core's in-process
 * MCP bridge (`apps/core/src/sidecar/adapters/mcp_bridge.rs`). Pi (via `pi-acp`)
 * advertises NO MCP-server support, so that bridge is skipped for it — which means
 * the DEFAULT agent could not call a single Ryu tool, and in particular could not
 * trigger a widget-bearing tool (ChatGPT/OpenAI Apps-SDK style: an MCP tool whose
 * result renders an interactive inline widget). This extension closes that gap by
 * giving Pi a small proxy toolset that calls Core's HTTP tool API.
 *
 * NATIVE MCP (Pi 1.x)
 * -------------------
 * Pi now ships its own MCP client, while pi-acp still ignores `session/new`
 * `mcpServers`. So on session start this extension also registers Core's bridge
 * itself (`/api/acp/mcp`, same capability) as Pi MCP server `ryu`; see
 * [`nativeMcpServerConfig`]. The agent's granted tools then arrive as deferred
 * `mcp__ryu__*` tools, and Core emits their widgets and permission prompts from
 * the capability record. `ryu_call_tool` stays for ids that are searchable but
 * not listed (Composio actions, app API operations) and for older Pi builds.
 *
 * DESIGN: ONE GENERIC PROXY (+ a discovery tool), NOT A CATALOG MIRROR
 * --------------------------------------------------------------------
 * Pi has no bridge, so this extension is Pi's ONLY access to Ryu tools. We register
 * a single generic proxy (`ryu_call_tool`) plus a discovery tool (`ryu_list_tools`)
 * instead of mirroring every Ryu tool as its own Pi tool because:
 *   - mirroring the full catalog would inject 100+ tool schemas into the DEFAULT
 *     agent's prompt on every turn (real latency/quality regression), and
 *   - it would require converting each tool's JSON Schema into a TypeBox schema,
 *     which is fragile and untestable without a live Pi.
 * The model still invokes a widget-bearing tool BY NAME: it passes the tool's
 * fully-qualified id (e.g. `quest-board.list_quests`) as the `tool` argument, and
 * the available tools are advertised in `ryu_call_tool`'s description (folded in at
 * load time) plus discoverable via `ryu_list_tools`.
 *
 * THE WIDGET CHANNEL (keep the payload RAW)
 * -----------------------------------------
 * `ryu_call_tool` returns the MCP result's TEXT blocks to the model as `content`
 * (the only field pi-acp folds back into the prompt, via `toolResultToText`), and
 * stashes the RAW MCP result — including `_meta`/`structuredContent` — in the tool
 * result's `details.ryuWidget`. pi-acp preserves `details` as the ACP
 * `tool_call_update.rawOutput`, where Core's ACP handler
 * (`adapters/acp.rs`, `SessionUpdate::ToolCallUpdate`) reads `details.ryuWidget`
 * and rebuilds the widget event with the SHARED `build_widget_event`. The widget
 * payload is presentation data for a sandboxed iframe and is never folded into the
 * model prompt (it rides in `details`, which the model never sees), so it stays raw
 * — the model edge is neutralized elsewhere (`mcp_bridge.rs::widget_payload`).
 *
 * TRUST / SCOPE
 * -------------
 * Core injects one short-lived capability for this exact ACP session. It is
 * accepted only by Core's dedicated ACP callback; the callback resolves the
 * verified caller, conversation, agent, and narrowing scopes from Core's
 * server-side record. Once Pi has created its native session, each tool request
 * also carries that native id so Core can reject a capability replayed by a
 * different ACP session. No node-wide bearer or user JWT crosses this boundary.
 *
 * BEYOND TOOLS: COMMANDS + ctx.ui
 * -------------------------------
 * Core spawns the managed Pi as `pi --mode rpc --no-themes` (see
 * `acp.rs::ryu_pi_acp_cmd`), and Pi's rpc mode binds a REAL `uiContext`, so
 * `ctx.hasUI` is true and the fire-and-forget UI methods (`setStatus`,
 * `setWidget`, `notify`) are emitted as `extension_ui_request` frames instead of
 * being no-ops. rpc mode also dispatches extension commands: `session.prompt()`
 * routes any prompt starting with `/` through `_tryExecuteExtensionCommand`
 * BEFORE the LLM sees it. So this extension also registers:
 *   - `/ryu-tools [query]` — list the Ryu tools this agent may call, and
 *   - `/ryu-call <tool> [json]` — invoke one directly, without a model turn.
 * Both go through the same HTTP helpers as the model-facing tools, so there is
 * exactly one code path to Core. A command-invoked tool does NOT render a widget
 * (a command has no tool-result channel back to pi-acp, and `details.ryuWidget`
 * only rides an ACP `tool_call_update`); that is deliberate — the widget path is
 * `ryu_call_tool`, and it is left untouched.
 *
 * Every `ctx.ui.*` call is guarded on `ctx.hasUI` AND wrapped in try/catch. Both
 * halves are load-bearing: `hasUI` is a getter that calls `assertActive()` and
 * THROWS once Pi invalidates this extension instance (reload / session replace),
 * so a background repaint scheduled before a reload would throw from the guard
 * itself. An exception escaping an extension callback is reported as an
 * extension error and can abort the surrounding command, so cosmetic UI must
 * never be able to break a Ryu turn.
 *
 * We deliberately use NO interactive UI method (`select` / `confirm` / `input` /
 * `editor`). Those block on a human answering an `extension_ui_request`, and
 * over ACP the managed Pi is frequently driven headlessly with nobody watching —
 * a prompt there would hang the turn until its timeout rather than fail open.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	McpServerConfig,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

/** Core ACP transport carries JSON values; validation retains the original object. */
type McpJsonValue =
	| null
	| boolean
	| number
	| string
	| McpJsonValue[]
	| McpJsonObject;
interface McpJsonObject {
	[key: string]: McpJsonValue;
}
const mcpJsonValueSchema = Type.Cyclic(
	{
		Value: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("Value")),
			Type.Record(Type.String(), Type.Ref("Value")),
		]),
	},
	"Value"
);
const mcpTextSchema = Type.Object({
	type: Type.Literal("text"),
	text: Type.String(),
});
const mcpContentSchema = Type.Object({
	content: Type.Array(mcpJsonValueSchema),
});
const mcpStructuredSchema = Type.Object({
	structuredContent: mcpJsonValueSchema,
});
const catalogSchema = Type.Object({
	tools: Type.Array(
		Type.Object({
			id: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
		})
	),
});
const callEnvelopeSchema = Type.Object({
	ok: Type.Optional(Type.Boolean()),
	error: Type.Optional(Type.String()),
	output: Type.Optional(mcpJsonValueSchema),
});

const CORE_URL = (
	process.env.RYU_MCP_CORE_URL || "http://127.0.0.1:7980"
).replace(/\/+$/, "");
const AGENT_ID = process.env.RYU_MCP_AGENT_ID || "ryu";
const SESSION_CAPABILITY = process.env.RYU_MCP_SESSION_CAPABILITY || "";
// This is the Core broker record id. The native ACP session id is read from
// `ctx.sessionManager` once Pi has created its session and sent separately.
const BROKER_SESSION_ID = process.env.RYU_MCP_ACP_SESSION_ID || "";

/**
 * Name of Core's bridge as a native Pi MCP server. Pi names its tools
 * `mcp__ryu__<tool>` (dots in Ryu ids become `_`); `ryu-plan.ts` matches that
 * prefix, so renaming it here must be mirrored there.
 */
export const NATIVE_MCP_SERVER = "ryu";

/** A Ryu tool may run for minutes; Pi's per-request default is 60 seconds. */
const NATIVE_MCP_TIMEOUT_SECONDS = 15 * 60;

/** Child Pis spawned by the subagent plugin; their model calls are not this turn's. */
const IS_SUBAGENT = process.env.RYU_PI_SUBAGENT === "1";

/** Bound on the per-message usage report, which the turn waits on (see below). */
const USAGE_REPORT_TIMEOUT_MS = 1500;

/** Cap on how many tools we fold into a prompt/description to keep it lean. */
const CATALOG_CAP = 60;

/**
 * Bound on the catalog GET. Mirrors Core's 8s hook timeouts
 * (`sidecar/mcp/mod.rs::PRE_TOOL_HOOK_TIMEOUT`). This one matters more than it
 * looks: the catalog is fetched at extension LOAD, so an unreachable-but-not-
 * refusing Core (a half-open loopback socket) would otherwise hang extension
 * load forever and the managed Pi would never finish starting. On timeout the
 * fetch rejects, `fetchCatalog`'s catch returns [], and we fall back to the
 * generic description + `ryu_list_tools`. The tool-CALL POST is deliberately
 * NOT bounded this way — a real Ryu tool may legitimately run for minutes.
 */
const CATALOG_TIMEOUT_MS = 8000;

/** Key for this extension's footer status + editor widget slots. */
const RYU_UI_KEY = "ryu";

/** Cap on tool lines rendered into the widget so it cannot swallow the screen. */
const WIDGET_LIST_CAP = 12;

/**
 * True when this Pi was launched by `pi-acp` rather than by a human in a terminal.
 * pi-acp spawns `pi --mode rpc --no-themes` (verified: `process.argv` inside a live
 * ACP-driven turn is `[node, …/.bin/pi, "--mode", "rpc", "--no-themes"]`).
 *
 * WHY THIS GATE EXISTS: a registered slash command reached over ACP **hangs the
 * turn**. Pi's `AgentSession.prompt` handles extension commands first and returns
 * early — `preflightResult?.(true); return;` — without running the agent loop, so
 * no `agent_end` is ever emitted. pi-acp settles its `pendingTurn` only from
 * `agent_end` (or from the `.catch` on an RPC error, which does not fire because
 * `proc.prompt()` resolved fine), so the ACP `session/prompt` request never
 * returns and the chat spins until Core's turn timeout.
 *
 * Verified by running it, not inferred: registering a probe command and sending
 * `/probe` over ACP ran the handler (so the command dispatched) and then timed
 * out waiting for `session/prompt` to return.
 *
 * The two commands below are pure TUI decoration (`setStatus`/`setWidget`/
 * `notify`), all of which pi-acp discards anyway — so under ACP they cost a hung
 * turn and buy nothing. They stay registered for a human running the managed Pi
 * directly in a terminal, where they work and are useful. The model reaches the
 * same functionality over ACP through the `ryu_list_tools` / `ryu_call_tool`
 * tools, which are unaffected.
 *
 * NOTE FOR ANY FUTURE RYU PI EXTENSION: do not register a slash command without
 * this gate. `ryu-plan.ts`, `ryu-subagent.ts` and `ryu-shell.ts` register none at
 * all, deliberately — `/plan` must fall through to the `input` event instead.
 */
const IS_ACP_RPC = ((): boolean => {
	const argv = process.argv;
	const i = argv.indexOf("--mode");
	return i !== -1 && argv[i + 1] === "rpc";
})();

/**
 * Last fetched unfiltered catalog. Kept so the status line and the `/ryu-call`
 * argument completions are answerable without another round trip to Core (a
 * completion provider fires per keystroke). It is a display cache only — the
 * authoritative allowlist check always happens in Core on the call itself.
 */
let catalogCache: CatalogTool[] = [];

/** One-line description of the most recent Ryu tool activity, for the status. */
let lastActivity = "";

function nativeSessionId(ctx?: ExtensionContext): string | undefined {
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		return id && id.length > 0 ? id : undefined;
	} catch {
		// A detached callback may observe a stale extension context during reload.
		return undefined;
	}
}

function sessionCapabilityHeaders(nativeSession?: string) {
	if (!(SESSION_CAPABILITY && BROKER_SESSION_ID)) {
		throw new Error(
			"Core did not provision this managed Pi session for Ryu tools"
		);
	}
	const headers = new Headers({
		authorization: `Bearer ${SESSION_CAPABILITY}`,
		"content-type": "application/json",
		"x-ryu-acp-session-id": BROKER_SESSION_ID,
	});
	if (nativeSession) {
		headers.set("x-ryu-acp-native-session-id", nativeSession);
	}
	return headers;
}

/**
 * Pi's built-in MCP client config for Core's bridge in THIS session.
 *
 * Pi 1.x ships an MCP client, but pi-acp still drops `session/new`
 * `mcpServers`, so Core serves the same governed bridge every other ACP agent
 * gets at `/api/acp/mcp` and this extension registers it. Core emits widgets and
 * permission prompts for these calls itself, from the capability's server-side
 * record, so nothing widget-related rides back through Pi.
 *
 * - The capability is referenced as `${RYU_MCP_SESSION_CAPABILITY}`, which Pi
 *   expands from its environment when it connects, so the secret never sits in
 *   the registered config that `/mcp` and `pi.getMcpServers()` show.
 * - `deferred`: the agent's granted tools stay out of every prompt until Pi's
 *   `tool_search` loads a match, which also keeps the prompt cache stable while
 *   the catalog changes. Codemode scripts can call them either way.
 * - `ask_user` is direct: it is the question card, useless if it must be found.
 * - While Pi's codemode is active, Core's own `execute`/`resume` sandbox is
 *   hidden: codemode replaces it, and two script sandboxes would only confuse
 *   the model. With codemode off (`"defaultTools": ["-codemode"]`) they keep the
 *   server's deferred exposure, so Pi is not left without a script sandbox.
 *   The `/api/acp/tools` proxy path needs no such rule: Core's catalog there is
 *   registry-only and never offers either meta-tool.
 */
export function nativeMcpServerConfig(
	nativeSession: string,
	codemode: boolean
): McpServerConfig {
	const toolExposure: Record<string, "direct" | "hidden"> = {
		ask_user: "direct",
	};
	if (codemode) {
		toolExposure.execute = "hidden";
		toolExposure.resume = "hidden";
	}
	return {
		url: `${CORE_URL}/api/acp/mcp`,
		headers: {
			// Pi expands `${NAME}` from its own environment when it connects.
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Pi's header syntax, not a template.
			authorization: "Bearer ${RYU_MCP_SESSION_CAPABILITY}",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Pi's header syntax, not a template.
			"x-ryu-acp-session-id": "${RYU_MCP_ACP_SESSION_ID}",
			"x-ryu-acp-native-session-id": nativeSession,
		},
		description:
			"Ryu tools for this chat: apps, connected services, and tools that render an interactive app in the chat.",
		exposure: "deferred",
		toolExposure,
		timeout: NATIVE_MCP_TIMEOUT_SECONDS,
	};
}

/** Pi's codemode tool name (`pi_config::PI_CODEMODE_DEFAULT_TOOL` without its `+`). */
const PI_CODEMODE_TOOL = "codemode";

/**
 * Whether Pi's codemode tool is active for this session. Pi applies
 * `defaultTools` when it builds the session, before `session_start`, so the
 * answer is settled by the time the bridge registers. An unbound runtime
 * throws; that counts as active, the managed default Core writes.
 */
function codemodeActive(pi: ExtensionAPI): boolean {
	try {
		return pi.getActiveTools().includes(PI_CODEMODE_TOOL);
	} catch {
		return true;
	}
}

/**
 * True when this Pi can reach Core's bridge through its own MCP client.
 *
 * Never in a `ryu-subagent` child (`RYU_PI_SUBAGENT=1`): it inherits the
 * parent's environment but runs its own native session, which the capability
 * is not bound to, so every native call would be refused after `tools/list`
 * had already advertised the tools.
 */
function nativeMcpSupported(pi: ExtensionAPI): boolean {
	return (
		typeof pi.registerMcpServer === "function" &&
		process.env.RYU_PI_SUBAGENT !== "1" &&
		Boolean(SESSION_CAPABILITY && BROKER_SESSION_ID)
	);
}

/**
 * Register (or re-register, after a session switch) Core's bridge for the
 * current native session. Pi's session ids are UUIDs; anything else is refused
 * rather than written into a header whose values Pi expands (`${..}`, `!cmd`).
 * Never throws: a failed registration leaves `ryu_call_tool` as the road in.
 */
function registerNativeMcp(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
	const nativeSession = nativeSessionId(ctx);
	if (!(nativeSession && /^[A-Za-z0-9_.:-]{1,128}$/.test(nativeSession))) {
		return false;
	}
	try {
		pi.registerMcpServer(
			NATIVE_MCP_SERVER,
			nativeMcpServerConfig(nativeSession, codemodeActive(pi))
		);
		return true;
	} catch {
		return false;
	}
}

/** Pi provider and image API names for the Gateway's image models. */
const GATEWAY_IMAGES_PROVIDER = "ryu-gateway-images";
const GATEWAY_IMAGES_API = "ryu-gateway-images";
/** Core's Pi provider id for the Gateway (`pi_config::GATEWAY_PROVIDER_ID`). */
const GATEWAY_CHAT_PROVIDER = "gateway";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const gatewayModelsSchema = Type.Object({
	data: Type.Array(
		Type.Object({
			id: Type.String(),
			modality: Type.Optional(Type.String()),
		})
	),
});
const gatewayImageSchema = Type.Object({
	b64_json: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	content_type: Type.Optional(Type.String()),
	revised_prompt: Type.Optional(Type.String()),
});
const gatewayImagesResponseSchema = Type.Object({
	data: Type.Array(gatewayImageSchema),
});

interface GatewayEndpoint {
	baseUrl: string;
	headers: Record<string, string>;
}

/** Where Pi's own Gateway chat provider points, with its resolved auth. */
async function gatewayEndpoint(
	ctx: ExtensionContext
): Promise<GatewayEndpoint | undefined> {
	const chat = ctx.modelRegistry
		.getAll()
		.find((model) => model.provider === GATEWAY_CHAT_PROVIDER);
	if (!chat?.baseUrl) {
		return;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(chat);
	if (!auth.ok) {
		return;
	}
	// Pi resolves the provider's configured headers (routing, conversation id)
	// into `auth.headers`; a null value there means "send no such header".
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(auth.headers ?? {})) {
		if (typeof value === "string") {
			headers[name] = value;
		}
	}
	if (auth.apiKey) {
		headers.authorization = `Bearer ${auth.apiKey}`;
	}
	const baseUrl = auth.baseUrl ?? chat.baseUrl;
	return { baseUrl: baseUrl.replace(/\/+$/, ""), headers };
}

/** Largest hosted image Pi downloads from a Gateway-returned URL (20 MiB). */
const MAX_GATEWAY_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Read a hosted image body, refusing anything over `MAX_GATEWAY_IMAGE_BYTES`.
 * The declared length is checked first; the stream is still counted because
 * the header can be absent or wrong.
 */
async function readCappedImage(response: Response): Promise<Buffer> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_GATEWAY_IMAGE_BYTES) {
		await response.body?.cancel();
		throw new Error("image download failed: image too large");
	}
	const reader = response.body?.getReader();
	if (!reader) {
		return Buffer.alloc(0);
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > MAX_GATEWAY_IMAGE_BYTES) {
			await reader.cancel();
			throw new Error("image download failed: image too large");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks, total);
}

/**
 * Turn one OpenAI-shaped `data[]` entry from the Gateway into Pi image output.
 * Hosted URLs are fetched once so the image reaches the model inline; the
 * download must be an `image/*` response no larger than 20 MiB.
 */
async function gatewayImageOutput(
	image: { b64_json?: string; url?: string; content_type?: string },
	signal: AbortSignal | undefined
): Promise<{ type: "image"; mimeType: string; data: string } | undefined> {
	if (image.b64_json) {
		return {
			type: "image",
			mimeType: image.content_type || "image/png",
			data: image.b64_json,
		};
	}
	const inline = image.url?.match(/^data:([^;]+);base64,(.+)$/);
	if (inline) {
		return { type: "image", mimeType: inline[1], data: inline[2] };
	}
	if (!image.url?.startsWith("https://")) {
		return;
	}
	const response = await fetch(image.url, { signal });
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`image download failed: HTTP ${response.status}`);
	}
	const mimeType = response.headers
		.get("content-type")
		?.split(";")[0]
		?.trim()
		.toLowerCase();
	if (!mimeType?.startsWith("image/")) {
		await response.body?.cancel();
		throw new Error("image download failed: response is not an image");
	}
	const bytes = await readCappedImage(response);
	return { type: "image", mimeType, data: bytes.toString("base64") };
}

/**
 * Pi's image API for the Gateway's `POST /v1/images/generations`. The Gateway
 * runs the same budget, policy and audit pipeline as chat, so Pi image calls
 * are governed exactly like Core's own image route. Never rejects: failures
 * come back as `stopReason: "error"`, which is Pi's image contract.
 */
function gatewayGenerateImages(endpoint: () => GatewayEndpoint | undefined) {
	return async (
		model: { api: string; provider: string; id: string },
		context: {
			input: Array<{ type: string; text?: string }>;
		},
		options?: { signal?: AbortSignal }
	) => {
		const result = {
			api: model.api,
			provider: model.provider,
			model: model.id,
			output: [] as Array<
				| { type: "image"; mimeType: string; data: string }
				| { type: "text"; text: string }
			>,
			stopReason: "stop" as "stop" | "error" | "aborted",
			errorMessage: undefined as string | undefined,
			timestamp: Date.now(),
		};
		try {
			const target = endpoint();
			if (!target) {
				throw new Error("the Ryu Gateway is not configured for this agent");
			}
			if (context.input.some((item) => item.type === "image")) {
				throw new Error("the Ryu Gateway image route takes a text prompt only");
			}
			const prompt = context.input
				.map((item) => (item.type === "text" ? (item.text ?? "") : ""))
				.join("\n")
				.trim();
			if (!prompt) {
				throw new Error("an image prompt is required");
			}
			const response = await fetch(`${target.baseUrl}/images/generations`, {
				method: "POST",
				headers: { ...target.headers, "content-type": "application/json" },
				body: JSON.stringify({
					model: model.id,
					prompt,
					response_format: "b64_json",
				}),
				signal: options?.signal,
			});
			const body: unknown = await response.json().catch(() => undefined);
			if (!response.ok) {
				const message =
					typeof body === "object" && body && "error" in body
						? JSON.stringify((body as { error: unknown }).error)
						: `HTTP ${response.status}`;
				throw new Error(`Ryu Gateway image generation failed: ${message}`);
			}
			if (!Check(gatewayImagesResponseSchema, body)) {
				throw new Error("Ryu Gateway returned an unexpected image response");
			}
			for (const image of body.data) {
				const output = await gatewayImageOutput(image, options?.signal);
				if (output) {
					result.output.push(output);
				}
				if (image.revised_prompt) {
					result.output.push({ type: "text", text: image.revised_prompt });
				}
			}
			if (!result.output.some((item) => item.type === "image")) {
				throw new Error("Ryu Gateway returned no image");
			}
		} catch (error) {
			result.stopReason = options?.signal?.aborted ? "aborted" : "error";
			result.errorMessage =
				error instanceof Error ? error.message : String(error);
		}
		return result;
	};
}

/**
 * Offer the Gateway's image models to Pi (and so to codemode's
 * `pi.images.generate`). Models come from the Gateway's own `/v1/models`
 * (`modality: "image"`), so only models a configured provider serves appear.
 * Nothing is registered when Pi has no Gateway provider. Never throws.
 */
async function registerGatewayImages(
	pi: ExtensionAPI,
	ctx: ExtensionContext
): Promise<boolean> {
	try {
		const endpoint = await gatewayEndpoint(ctx);
		if (!endpoint) {
			return false;
		}
		const response = await fetch(`${endpoint.baseUrl}/models`, {
			headers: endpoint.headers,
			signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
		});
		const body: unknown = await response.json();
		if (!(response.ok && Check(gatewayModelsSchema, body))) {
			return false;
		}
		const ids = [
			...new Set(
				body.data
					.filter((model) => model.modality === "image")
					.map((model) => model.id)
			),
		];
		if (!ids.length) {
			return false;
		}
		// Auth is resolved again per call: the bearer can rotate within a session.
		let current: GatewayEndpoint | undefined = endpoint;
		const refresh = () => {
			gatewayEndpoint(ctx)
				.then((next) => {
					current = next;
				})
				.catch(() => {
					// Keep the last good endpoint; the call reports its own failure.
				});
			return current;
		};
		pi.registerProvider(GATEWAY_IMAGES_PROVIDER, {
			name: "Ryu Gateway images",
			baseUrl: endpoint.baseUrl,
			// The request carries the Gateway provider's own auth (see `refresh`);
			// this literal only marks the provider configured.
			apiKey: "ryu-gateway",
			images: {
				[GATEWAY_IMAGES_API]: {
					generateImages: gatewayGenerateImages(refresh),
				},
			},
			models: ids.map((id) => ({
				type: "image" as const,
				id,
				name: id,
				api: GATEWAY_IMAGES_API,
				input: ["text" as const],
				output: ["image" as const, "text" as const],
				// The Gateway meters and bills media itself.
				cost: ZERO_COST,
			})),
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Extract human-readable text from an MCP CallToolResult so the model sees an
 * actionable summary. Never returns the raw `structuredContent` blob as the
 * model-facing string — that belongs on the widget (details) channel.
 */
function resultText(output: McpJsonValue | undefined): string {
	if (output == null) {
		return "";
	}
	if (Check(Type.String(), output)) {
		return output;
	}
	if (Check(mcpContentSchema, output)) {
		const texts = output.content
			.filter((item) => Check(mcpTextSchema, item))
			.map((item) => item.text)
			.filter(Boolean);
		if (texts.length) {
			return texts.join("\n");
		}
	}
	// A widget-only tool may carry no text content; give the model a compact hint
	// that the tool ran and rendered a widget rather than an empty string.
	try {
		return JSON.stringify(
			Check(mcpStructuredSchema, output)
				? (output.structuredContent ?? output)
				: output
		);
	} catch {
		return String(output);
	}
}

/** Message of a thrown value, without assuming it is an Error. */
function errorText(err: Error): string {
	return err.message;
}

interface CatalogTool {
	description?: string;
	id?: string;
	name?: string;
}

/** Fetch the agent's tool catalog. Best-effort — returns [] on any failure. */
async function fetchCatalog(
	query?: string,
	ctx?: ExtensionContext
): Promise<CatalogTool[]> {
	try {
		const res = await fetch(`${CORE_URL}/api/acp/tools`, {
			method: "POST",
			headers: sessionCapabilityHeaders(nativeSessionId(ctx)),
			body: JSON.stringify({ action: "list_tools" }),
			signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
		});
		if (!res.ok) {
			return [];
		}
		const body = await res.json();
		let tools = Check(catalogSchema, body) ? body.tools : [];
		if (query?.trim()) {
			const q = query.trim().toLowerCase();
			tools = tools.filter((t) => {
				const hay =
					`${t.id ?? ""} ${t.name ?? ""} ${t.description ?? ""}`.toLowerCase();
				return hay.includes(q);
			});
		}
		return tools;
	} catch {
		return [];
	}
}

/**
 * Fetch the FULL catalog and refresh the display cache. Never rejects — it
 * delegates to `fetchCatalog`, whose failure mode is an empty list.
 */
async function refreshCatalog(ctx?: ExtensionContext): Promise<CatalogTool[]> {
	const tools = await fetchCatalog(undefined, ctx);
	catalogCache = tools;
	return tools;
}

/**
 * POST a Ryu tool call to Core and return its raw MCP result.
 *
 * The SINGLE path from this extension to Core's tool API: `ryu_call_tool`
 * (model-driven) and `/ryu-call` (user-driven) both land here, so the auth
 * header, the agent attribution and the error shape cannot drift apart. Throws
 * on transport or tool failure — `ryu_call_tool` lets that propagate (Pi marks
 * the result `isError` and reports it to the model), while the command catches
 * it and reports through the UI instead.
 */
async function callTool(
	tool: string,
	args: McpJsonValue,
	ctx?: ExtensionContext
): Promise<McpJsonValue | undefined> {
	const res = await fetch(`${CORE_URL}/api/acp/tools`, {
		method: "POST",
		headers: sessionCapabilityHeaders(nativeSessionId(ctx)),
		body: JSON.stringify({ action: "call_tool", tool, arguments: args }),
	});
	const body = await res.json().catch(() => ({}));
	if (!Check(callEnvelopeSchema, body)) {
		throw new Error(`${tool} failed: invalid Core tool response`);
	}
	if (!res.ok || body?.ok === false) {
		throw new Error(`${tool} failed: ${body?.error ?? `HTTP ${res.status}`}`);
	}
	return body?.output;
}

/**
 * Run `fn` against Pi's UI context, or do nothing at all.
 *
 * The `ctx?.hasUI` read is INSIDE the try on purpose: `hasUI` is a getter that
 * calls `assertActive()` and throws once this extension instance is invalidated
 * by a reload or session replacement, which a repaint scheduled from a detached
 * continuation can easily race. Swallowing here is the whole point — UI is
 * decoration, and a mode without a bound uiContext (print/json) must degrade to
 * silence rather than to a broken turn.
 */
function withUi(
	ctx: ExtensionContext | undefined,
	fn: (ui: ExtensionContext["ui"]) => void
): void {
	try {
		if (!ctx?.hasUI) {
			return;
		}
		fn(ctx.ui);
	} catch {
		// Stale extension instance, or a mode that does not implement this method.
	}
}

/** The footer status line: which Ryu agent is bound and what it last did. */
function statusLine(): string {
	const base = `Ryu ${AGENT_ID} · ${catalogCache.length} tools`;
	return lastActivity ? `${base} · ${lastActivity}` : base;
}

/**
 * Repaint the persistent Ryu status + widget. Cheap and idempotent, so it is
 * safe to call from a `finally` — including on the failure path, where the
 * status is exactly what the user needs to see.
 */
function paintRyuState(ctx: ExtensionContext | undefined): void {
	withUi(ctx, (ui) => {
		ui.setStatus(RYU_UI_KEY, statusLine());
		ui.setWidget(RYU_UI_KEY, [statusLine()]);
	});
}

/**
 * Render the Ryu widget as the state line plus a CAPPED tool listing. The cap
 * matters: the widget is pinned above Pi's editor, so an uncapped 100-tool
 * catalog would push the actual conversation off the screen.
 */
function listingWidget(tools: CatalogTool[]): string[] {
	const lines = [statusLine()];
	if (!tools.length) {
		lines.push("  (no Ryu tools available for this agent)");
		return lines;
	}
	for (const tool of tools.slice(0, WIDGET_LIST_CAP)) {
		const id = tool.id || tool.name;
		if (id) {
			lines.push(`  ${id}`);
		}
	}
	if (tools.length > WIDGET_LIST_CAP) {
		lines.push(`  …and ${tools.length - WIDGET_LIST_CAP} more`);
	}
	return lines;
}

/**
 * Split `/ryu-call <tool-id> [json-arguments]` into a call, or into the message
 * to show the user. Returning the error rather than throwing keeps the command
 * handler flat and guarantees a bad invocation is reported, never propagated as
 * an extension error.
 */
function parseCallCommand(
	input: string
): { tool: string; args: McpJsonValue } | { error: string } {
	const trimmed = input.trim();
	const sep = trimmed.indexOf(" ");
	const tool = (sep === -1 ? trimmed : trimmed.slice(0, sep)).trim();
	if (!tool) {
		return {
			error:
				"/ryu-call <tool-id> [json-arguments] — run /ryu-tools to see the ids.",
		};
	}
	const rawArgs = sep === -1 ? "" : trimmed.slice(sep + 1).trim();
	if (!rawArgs) {
		return { tool, args: {} };
	}
	try {
		const args = JSON.parse(rawArgs);
		if (!Check(mcpJsonValueSchema, args)) {
			throw new Error("arguments contain a non-JSON value");
		}
		return { tool, args };
	} catch (err) {
		return {
			error: `/ryu-call: arguments must be a JSON object (${errorText(err instanceof Error ? err : new Error(String(err)))}).`,
		};
	}
}

/** Render a catalog into compact one-line-per-tool bullets. */
function renderCatalog(tools: CatalogTool[]): string {
	return tools
		.slice(0, CATALOG_CAP)
		.map((t) => {
			const id = t.id || t.name || "";
			if (!id) {
				return "";
			}
			const desc = (t.description || "").split("\n")[0]?.slice(0, 120) ?? "";
			return desc ? `- ${id}: ${desc}` : `- ${id}`;
		})
		.filter(Boolean)
		.join("\n");
}

export default async function (pi: ExtensionAPI) {
	const native = nativeMcpSupported(pi);
	// Without native MCP, fold the current tool catalog into the proxy's
	// description so the model can pick a tool BY NAME in one turn. With it, the
	// granted tools arrive as deferred `mcp__ryu__*` tools that Pi's
	// `tool_search` loads on demand, so folding them here would only re-add the
	// per-turn prompt cost that deferral removes. Best-effort either way: a fetch
	// failure (Core not yet reachable at load) must NOT throw — that would break
	// extension load and kill the whole path.
	const catalog = await refreshCatalog();
	const catalogText = native ? "" : renderCatalog(catalog);
	const baseCallDescription =
		"Call a Ryu tool by its fully-qualified id and return its result. Some Ryu " +
		"tools render an interactive inline widget (an app) in the chat — call them " +
		"the same way. Pass `tool` as the fully-qualified id (e.g. " +
		"`quest-board.list_quests`) and `arguments` as its JSON arguments object.";
	let callDescription = `${baseCallDescription}\n\nUse ryu_list_tools to discover available Ryu tools first.`;
	if (native) {
		callDescription = `${baseCallDescription}\n\nThe granted Ryu tools are also available directly as mcp__ryu__* tools (load them with tool_search). Use ryu_call_tool for an id that mcp__ryu__tool_search found but that is not loadable that way, such as a Composio action or an app API operation.`;
	} else if (catalogText) {
		callDescription = `${baseCallDescription}\n\nAvailable Ryu tools:\n${catalogText}`;
	}

	pi.registerTool({
		name: "ryu_call_tool",
		label: "Ryu Tool",
		description: callDescription,
		promptSnippet: "Call a Ryu tool (or render a Ryu app widget) by id",
		promptGuidelines: [
			"Use ryu_call_tool to run any Ryu tool, including tools that render an interactive widget/app in the chat.",
			"Pass ryu_call_tool the tool's fully-qualified id in `tool`; if you do not know the id, call ryu_list_tools first.",
		],
		parameters: Type.Object({
			tool: Type.String({
				description:
					"Fully-qualified Ryu tool id, formatted <server>.<tool> (e.g. quest-board.list_quests).",
			}),
			// Open object: the model's structured arguments pass through unchanged.
			// (Type.Object({}) alone defaults to additionalProperties:false and would
			// strip every argument.)
			arguments: Type.Optional(
				Type.Object(
					{},
					{
						additionalProperties: true,
						description: "Arguments object for the tool.",
					}
				)
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const tool = params.tool.trim();
			if (!tool) {
				// Throwing marks the tool result isError:true and reports it to the LLM.
				throw new Error(
					"ryu_call_tool: `tool` is required (a fully-qualified Ryu tool id like quest-board.list_quests)."
				);
			}
			const args = params.arguments ?? {};
			if (!Check(mcpJsonValueSchema, args)) {
				throw new Error("ryu_call_tool: arguments must contain JSON values");
			}
			// Surface live activity in Pi's own status line. Pure decoration: the
			// repaint is guarded + swallowed, and the `finally` runs on both the
			// success and the throw path so the status can never stick on "calling".
			lastActivity = `calling ${tool}`;
			paintRyuState(ctx);
			try {
				const output = await callTool(tool, args, ctx);
				lastActivity = `ok ${tool}`;
				return {
					content: [{ type: "text", text: resultText(output) }],
					// WIDGET CHANNEL — Core reads `details.ryuWidget` off the ACP rawOutput and
					// synthesizes the ToolWidget event via the SHARED build_widget_event. This
					// never reaches the model prompt (pi-acp folds only `content`), so the raw
					// MCP `_meta`/`structuredContent` is delivered intact for the widget.
					details: { ryuWidget: { tool, arguments: args, output } },
				};
			} catch (err) {
				lastActivity = `failed ${tool}`;
				// Rethrown with the SAME `ryu_call_tool: <tool> failed: <reason>` text the
				// model has always seen — `callTool` produces the suffix, this restores
				// the tool-name prefix that moving the POST out of here would have lost.
				throw new Error(
					`ryu_call_tool: ${errorText(err instanceof Error ? err : new Error(String(err)))}`
				);
			} finally {
				paintRyuState(ctx);
			}
		},
	});

	pi.registerTool({
		name: "ryu_list_tools",
		label: "List Ryu Tools",
		description:
			"List the Ryu tools this agent can call (each id is usable with ryu_call_tool). " +
			"Optionally filter by a keyword query.",
		promptSnippet: "Discover available Ryu tools",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Optional keyword to filter tools by id/name/description.",
				})
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const query = (params.query ?? "").trim();
			const tools = await fetchCatalog(query || undefined, ctx);
			const text = tools.length
				? renderCatalog(tools)
				: "No Ryu tools are available for this agent.";
			return {
				content: [{ type: "text", text }],
				details: { count: tools.length },
			};
		},
	});

	// Report each assistant message's token usage to Core. pi-acp forwards only
	// context occupancy over ACP, so without this the chat's stats footer and the
	// context popup's prompt-cache hit rate stay empty for the managed Pi. The POST
	// is awaited on purpose: Pi awaits extension handlers before forwarding the
	// event to pi-acp, so the report reaches Core before the turn can end. It is
	// bounded and best-effort — a slow or absent Core costs one short wait, never
	// the turn. Child Pis (subagents) are not this conversation's model calls.
	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (IS_SUBAGENT || message.role !== "assistant" || !message.usage) {
			return;
		}
		const { input, output, cacheRead, cacheWrite, reasoning, totalTokens } =
			message.usage;
		try {
			await fetch(`${CORE_URL}/api/acp/tools`, {
				method: "POST",
				headers: sessionCapabilityHeaders(nativeSessionId(ctx)),
				body: JSON.stringify({
					action: "report_usage",
					usage: {
						input,
						output,
						cacheRead,
						cacheWrite,
						reasoning,
						totalTokens,
					},
				}),
				signal: AbortSignal.timeout(USAGE_REPORT_TIMEOUT_MS),
			});
		} catch {
			// Unprovisioned session or unreachable Core: the turn's stats simply lack
			// token counts, exactly as before this report existed.
		}
	});

	// Bind the Ryu state to Pi's own chrome as soon as a session exists. There is
	// no ctx at extension-load time (the factory is handed `pi`, not `ctx`), so
	// `session_start` is the earliest point at which the status/widget slots can
	// be written at all.
	pi.on("session_start", (_event, ctx) => {
		// The native session id exists from here on, and Pi connects a server
		// registered after load right away, so this is the earliest point the
		// bridge can be registered with the id Core bound at `session/new`.
		if (native) {
			registerNativeMcp(pi, ctx);
		}
		// Detached: discovery is a Gateway round trip and session start must not
		// wait on it.
		registerGatewayImages(pi, ctx).catch(() => {
			// `registerGatewayImages` already swallows its own failures.
		});
		// Paint from the cached catalog IMMEDIATELY, then refresh out of band. The
		// refresh is deliberately NOT awaited: session start must never block on a
		// Core round trip (an unreachable Core would otherwise add the full 8s
		// catalog bound to every single session start) and this handler's only job
		// is decoration.
		paintRyuState(ctx);
		refreshCatalog(ctx)
			.then(() => paintRyuState(ctx))
			.catch(() => {
				// `fetchCatalog` already swallows its own failures; this is belt-and-
				// braces so a detached repaint can never become an unhandled rejection
				// in Pi's process.
			});
	});

	// Terminal-only: over ACP a registered slash command hangs the turn. See
	// `IS_ACP_RPC`. The tools stay registered unconditionally above — only these
	// human-facing commands are gated.
	if (IS_ACP_RPC) {
		return;
	}

	pi.registerCommand("ryu-tools", {
		description:
			"List the Ryu tools this agent can call, optionally filtered by keyword.",
		async handler(args, ctx) {
			const query = args.trim();
			// An unfiltered listing doubles as a cache refresh so the status count and
			// the /ryu-call completions stay honest; a filtered one must not clobber
			// the cache with a subset.
			const tools = query
				? await fetchCatalog(query, ctx)
				: await refreshCatalog(ctx);
			lastActivity = query
				? `listed ${tools.length} matching "${query}"`
				: `listed ${tools.length}`;
			withUi(ctx, (ui) => {
				ui.setStatus(RYU_UI_KEY, statusLine());
				ui.setWidget(RYU_UI_KEY, listingWidget(tools));
				ui.notify(
					tools.length
						? `${tools.length} Ryu tool(s) available — invoke one with /ryu-call <id> [json].`
						: "No Ryu tools are available for this agent.",
					tools.length ? "info" : "warning"
				);
			});
		},
	});

	pi.registerCommand("ryu-call", {
		description:
			"Invoke a Ryu tool directly: /ryu-call <tool-id> [json-arguments]",
		getArgumentCompletions(argumentPrefix) {
			// Answered from the display cache on purpose: a completion provider fires
			// per keystroke, and hitting Core on each one would be a self-inflicted
			// request storm for a purely cosmetic list.
			const prefix = argumentPrefix.trim().toLowerCase();
			const items: { value: string; label: string; description?: string }[] =
				[];
			for (const tool of catalogCache) {
				const id = tool.id || tool.name;
				if (!id || (prefix && !id.toLowerCase().includes(prefix))) {
					continue;
				}
				const desc =
					(tool.description || "").split("\n")[0]?.slice(0, 120) ?? "";
				items.push({ value: id, label: id, description: desc || undefined });
				if (items.length >= WIDGET_LIST_CAP) {
					break;
				}
			}
			return items.length ? items : null;
		},
		async handler(args, ctx) {
			const parsed = parseCallCommand(args);
			if ("error" in parsed) {
				withUi(ctx, (ui) => {
					ui.notify(parsed.error, "warning");
				});
				return;
			}
			const { tool } = parsed;
			lastActivity = `calling ${tool}`;
			paintRyuState(ctx);
			try {
				const output = await callTool(tool, parsed.args, ctx);
				const text = resultText(output);
				lastActivity = `ok ${tool}`;
				withUi(ctx, (ui) => {
					ui.notify(text || `${tool} ran and returned no text output.`, "info");
				});
				// Leave the result in the transcript so the model can reference it on the
				// user's NEXT message. `triggerTurn` stays false on purpose: the user ran
				// a command, not a prompt, and silently starting an LLM turn (with its
				// cost, and its interleaving against an in-flight ACP turn) is not what
				// they asked for. Wrapped because `sendMessage` throws on a stale runtime
				// — by then the UI has already shown the result, so there is nothing to
				// recover and nothing worth breaking the command over.
				try {
					pi.sendMessage(
						{
							customType: "ryu_tool_result",
							content: `Ran the Ryu tool \`${tool}\` via /ryu-call. Result:\n${text}`,
							display: true,
							details: { tool, arguments: parsed.args },
						},
						{ triggerTurn: false }
					);
				} catch {
					// Stale extension runtime — the UI already carried the result.
				}
			} catch (err) {
				lastActivity = `failed ${tool}`;
				withUi(ctx, (ui) => {
					ui.notify(
						`/ryu-call: ${errorText(err instanceof Error ? err : new Error(String(err)))}`,
						"error"
					);
				});
			} finally {
				paintRyuState(ctx);
			}
		},
	});
}
