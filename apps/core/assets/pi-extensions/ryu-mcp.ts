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
 * Injected at spawn by Core (`acp.rs::ryu_pi_acp_cmd`) into the MANAGED Pi ONLY:
 *   - RYU_MCP_CORE_URL   Core's own base URL (loopback).
 *   - RYU_MCP_AGENT_ID   the agent id whose allowlist gates the call ("ryu").
 *   - RYU_MCP_CORE_TOKEN Core node-admittance bearer (RYU_TOKEN); absent on
 *                        loopback dev where Core requires no token.
 *   - RYU_MCP_USER_JWT  verified human identity for shared-node requests.
 *   - RYU_MCP_HOST_CONVERSATION_ID server-derived conversation principal.
 * The call is attributed to RYU_MCP_AGENT_ID so Core enforces that agent's tool
 * allowlist and the Gateway governs execution — never a fail-open bypass.
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
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CORE_URL = (
	process.env.RYU_MCP_CORE_URL || "http://127.0.0.1:7980"
).replace(/\/+$/, "");
const AGENT_ID = process.env.RYU_MCP_AGENT_ID || "ryu";
const CORE_TOKEN = process.env.RYU_MCP_CORE_TOKEN || "";
const USER_JWT = process.env.RYU_MCP_USER_JWT || "";
const HOST_CONVERSATION_ID = process.env.RYU_MCP_HOST_CONVERSATION_ID || "";

/** Decode the optional Core-injected onboarding source scope. */
function profileScope(): Record<string, unknown> {
	const encoded = process.env.RYU_MCP_PROFILE_SCOPE || "";
	if (!encoded) {
		return {};
	}
	try {
		const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
		const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
		const bytes = Uint8Array.from(binary, (character) =>
			character.charCodeAt(0)
		);
		const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

const PROFILE_SCOPE = profileScope();

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

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (CORE_TOKEN) {
		headers.authorization = `Bearer ${CORE_TOKEN}`;
	}
	if (USER_JWT) {
		headers["x-ryu-user-jwt"] = USER_JWT;
	}
	return headers;
}

/** The MCP CallToolResult value returned by Core's HTTP tool API. */
interface McpResult {
	content?: Array<{ type?: string; text?: string }>;
	isError?: boolean;
	structuredContent?: unknown;
}

/**
 * Extract human-readable text from an MCP CallToolResult so the model sees an
 * actionable summary. Never returns the raw `structuredContent` blob as the
 * model-facing string — that belongs on the widget (details) channel.
 */
function resultText(output: unknown): string {
	if (output == null) {
		return "";
	}
	if (typeof output === "string") {
		return output;
	}
	const result = output as McpResult;
	const content = result.content;
	if (Array.isArray(content)) {
		const texts = content
			.map((c) =>
				c?.type === "text" && typeof c.text === "string" ? c.text : ""
			)
			.filter(Boolean);
		if (texts.length) {
			return texts.join("\n");
		}
	}
	// A widget-only tool may carry no text content; give the model a compact hint
	// that the tool ran and rendered a widget rather than an empty string.
	try {
		return JSON.stringify(result.structuredContent ?? output);
	} catch {
		return String(output);
	}
}

/** Message of a thrown value, without assuming it is an Error. */
function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface CatalogTool {
	description?: string;
	id?: string;
	name?: string;
}

/** Fetch the agent's tool catalog. Best-effort — returns [] on any failure. */
async function fetchCatalog(query?: string): Promise<CatalogTool[]> {
	try {
		const url = new URL(`${CORE_URL}/api/mcp/tools`);
		url.searchParams.set("agent", AGENT_ID);
		const res = await fetch(url.toString(), {
			headers: authHeaders(),
			signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
		});
		if (!res.ok) {
			return [];
		}
		const body = (await res.json()) as { tools?: CatalogTool[] };
		let tools = Array.isArray(body?.tools) ? body.tools : [];
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
async function refreshCatalog(): Promise<CatalogTool[]> {
	const tools = await fetchCatalog();
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
async function callTool(tool: string, args: unknown): Promise<unknown> {
	const res = await fetch(`${CORE_URL}/api/mcp/tools/call`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			tool,
			arguments: args,
			agent_id: AGENT_ID,
			host_conversation_id: HOST_CONVERSATION_ID || undefined,
			...PROFILE_SCOPE,
		}),
	});
	const body = (await res.json().catch(() => ({}))) as {
		ok?: boolean;
		output?: unknown;
		error?: string;
	};
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
): { tool: string; args: unknown } | { error: string } {
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
		return { tool, args: JSON.parse(rawArgs) };
	} catch (err) {
		return {
			error: `/ryu-call: arguments must be a JSON object (${errorText(err)}).`,
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
			const desc = (t.description || "").split("\n")[0].slice(0, 120);
			return desc ? `- ${id}: ${desc}` : `- ${id}`;
		})
		.filter(Boolean)
		.join("\n");
}

export default async function (pi: ExtensionAPI) {
	// Fold the current tool catalog into the proxy's description so the model can
	// pick a tool BY NAME in one turn. Best-effort: a fetch failure (Core not yet
	// reachable at load) must NOT throw — that would break extension load and kill
	// the whole path. We register with a generic description and rely on
	// `ryu_list_tools` at runtime instead.
	const catalog = await refreshCatalog();
	const catalogText = renderCatalog(catalog);
	const callDescription =
		"Call a Ryu tool by its fully-qualified id and return its result. Some Ryu " +
		"tools render an interactive inline widget (an app) in the chat — call them " +
		"the same way. Pass `tool` as the fully-qualified id (e.g. " +
		"`quest-board.list_quests`) and `arguments` as its JSON arguments object." +
		(catalogText
			? `\n\nAvailable Ryu tools:\n${catalogText}`
			: "\n\nUse ryu_list_tools to discover available Ryu tools first.");

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
			const tool = String((params as { tool?: unknown })?.tool ?? "").trim();
			if (!tool) {
				// Throwing marks the tool result isError:true and reports it to the LLM.
				throw new Error(
					"ryu_call_tool: `tool` is required (a fully-qualified Ryu tool id like quest-board.list_quests)."
				);
			}
			const args = (params as { arguments?: unknown })?.arguments ?? {};
			// Surface live activity in Pi's own status line. Pure decoration: the
			// repaint is guarded + swallowed, and the `finally` runs on both the
			// success and the throw path so the status can never stick on "calling".
			lastActivity = `calling ${tool}`;
			paintRyuState(ctx);
			try {
				const output = await callTool(tool, args);
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
				throw new Error(`ryu_call_tool: ${errorText(err)}`);
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
		async execute(_toolCallId, params) {
			const query = String((params as { query?: unknown })?.query ?? "").trim();
			const tools = await fetchCatalog(query || undefined);
			const text = tools.length
				? renderCatalog(tools)
				: "No Ryu tools are available for this agent.";
			return {
				content: [{ type: "text", text }],
				details: { count: tools.length },
			};
		},
	});

	// Bind the Ryu state to Pi's own chrome as soon as a session exists. There is
	// no ctx at extension-load time (the factory is handed `pi`, not `ctx`), so
	// `session_start` is the earliest point at which the status/widget slots can
	// be written at all.
	pi.on("session_start", (_event, ctx) => {
		// Paint from the cached catalog IMMEDIATELY, then refresh out of band. The
		// refresh is deliberately NOT awaited: session start must never block on a
		// Core round trip (an unreachable Core would otherwise add the full 8s
		// catalog bound to every single session start) and this handler's only job
		// is decoration.
		paintRyuState(ctx);
		refreshCatalog()
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
			const tools = query ? await fetchCatalog(query) : await refreshCatalog();
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
				const desc = (tool.description || "").split("\n")[0].slice(0, 120);
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
				const output = await callTool(tool, parsed.args);
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
					ui.notify(`/ryu-call: ${errorText(err)}`, "error");
				});
			} finally {
				paintRyuState(ctx);
			}
		},
	});
}
