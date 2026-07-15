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
 * fully-qualified id (e.g. `quest-board__list_quests`) as the `tool` argument, and
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
 * The call is attributed to RYU_MCP_AGENT_ID so Core enforces that agent's tool
 * allowlist and the Gateway governs execution — never a fail-open bypass.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CORE_URL = (process.env.RYU_MCP_CORE_URL || "http://127.0.0.1:7980").replace(
  /\/+$/,
  ""
);
const AGENT_ID = process.env.RYU_MCP_AGENT_ID || "ryu";
const CORE_TOKEN = process.env.RYU_MCP_CORE_TOKEN || "";

/** Cap on how many tools we fold into a prompt/description to keep it lean. */
const CATALOG_CAP = 60;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (CORE_TOKEN) {
    headers.authorization = `Bearer ${CORE_TOKEN}`;
  }
  return headers;
}

/** The MCP CallToolResult value returned by Core's HTTP tool API. */
interface McpResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
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
      .map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
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

interface CatalogTool {
  id?: string;
  name?: string;
  description?: string;
}

/** Fetch the agent's tool catalog. Best-effort — returns [] on any failure. */
async function fetchCatalog(query?: string): Promise<CatalogTool[]> {
  try {
    const url = new URL(`${CORE_URL}/api/mcp/tools`);
    url.searchParams.set("agent", AGENT_ID);
    const res = await fetch(url.toString(), { headers: authHeaders() });
    if (!res.ok) {
      return [];
    }
    const body = (await res.json()) as { tools?: CatalogTool[] };
    let tools = Array.isArray(body?.tools) ? body.tools : [];
    if (query?.trim()) {
      const q = query.trim().toLowerCase();
      tools = tools.filter((t) => {
        const hay = `${t.id ?? ""} ${t.name ?? ""} ${t.description ?? ""}`.toLowerCase();
        return hay.includes(q);
      });
    }
    return tools;
  } catch {
    return [];
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
  const catalog = await fetchCatalog();
  const catalogText = renderCatalog(catalog);
  const callDescription =
    "Call a Ryu tool by its fully-qualified id and return its result. Some Ryu " +
    "tools render an interactive inline widget (an app) in the chat — call them " +
    "the same way. Pass `tool` as the fully-qualified id (e.g. " +
    "`quest-board__list_quests`) and `arguments` as its JSON arguments object." +
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
          "Fully-qualified Ryu tool id, formatted <server>__<tool> (e.g. quest-board__list_quests).",
      }),
      // Open object: the model's structured arguments pass through unchanged.
      // (Type.Object({}) alone defaults to additionalProperties:false and would
      // strip every argument.)
      arguments: Type.Optional(
        Type.Object({}, { additionalProperties: true, description: "Arguments object for the tool." })
      ),
    }),
    async execute(_toolCallId, params) {
      const tool = String((params as { tool?: unknown })?.tool ?? "").trim();
      if (!tool) {
        // Throwing marks the tool result isError:true and reports it to the LLM.
        throw new Error(
          "ryu_call_tool: `tool` is required (a fully-qualified Ryu tool id like quest-board__list_quests)."
        );
      }
      const args = (params as { arguments?: unknown })?.arguments ?? {};
      const res = await fetch(`${CORE_URL}/api/mcp/tools/call`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ tool, arguments: args, agent_id: AGENT_ID }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        output?: unknown;
        error?: string;
      };
      if (!res.ok || body?.ok === false) {
        throw new Error(
          `ryu_call_tool: ${tool} failed: ${body?.error ?? `HTTP ${res.status}`}`
        );
      }
      const output = body?.output;
      return {
        content: [{ type: "text", text: resultText(output) }],
        // WIDGET CHANNEL — Core reads `details.ryuWidget` off the ACP rawOutput and
        // synthesizes the ToolWidget event via the SHARED build_widget_event. This
        // never reaches the model prompt (pi-acp folds only `content`), so the raw
        // MCP `_meta`/`structuredContent` is delivered intact for the widget.
        details: { ryuWidget: { tool, arguments: args, output } },
      };
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
        Type.String({ description: "Optional keyword to filter tools by id/name/description." })
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
}
