// Preamble injection for the assistant's "builder" mode. When a builder page
// (agent edit, workflows) takes over the global Ask Ryu panel, the model needs
// the builder instructions + target id + a config snapshot — but only riding the
// FIRST user message of the OUTGOING request, so the visible thread stays clean.
// Extracted from the former AgentBuilderChat / WorkflowBuilderChat so the single
// context-aware AssistantPanel can build either preamble.

import type { UIMessage } from "ai";
import type { AssistantBuilderSession } from "@/src/store/useAssistantStore.ts";

function agentPreamble(agentId: string, snapshot: string): string {
	return [
		"You are Ryu's agent builder. You are helping the user configure the agent",
		`with id "${agentId}".`,
		"When the user asks to change the agent (name, description, instructions,",
		"tools, skills, persona/tone, model, ...), call the",
		"agent_builder.configure_agent tool. Core will ask the user for permission",
		"inside chat before applying the change. If the user denies permission,",
		"explain that nothing changed. Use the *_add / *_remove array args to adjust",
		"tool/skill/connection lists. Call agent_builder.get_agent first if you",
		"need current values. Only use tools and skills that actually exist.",
		"Keep replies short and confirm what changed.",
		`\n\nCurrent configuration:\n${snapshot}`,
	].join(" ");
}

function workflowPreamble(workflowId: string, snapshot: string): string {
	return [
		"You are Ryu's workflow builder. You are helping the user assemble the workflow",
		`with id "${workflowId}". A workflow is a directed acyclic graph (DAG) of typed`,
		"nodes connected by edges. When the user describes what the workflow should do,",
		"BUILD it by calling the workflow_builder tools. For incremental edits prefer",
		`workflow_builder.configure_workflow with workflow_id "${workflowId}" using`,
		"nodes_upsert / nodes_remove / edges_add / edges_remove. Call",
		"workflow_builder.get_workflow first if you need the current graph. Wire a clear",
		"path from an input node to an output node. Keep node ids short and descriptive.",
		"If a save is rejected because the graph is invalid, read the error and fix it.",
		"Keep replies short and confirm what you changed.",
		`\n\nCurrent definition:\n${snapshot}`,
	].join(" ");
}

/**
 * Build the preamble for a session.
 *
 * The two BUILT-IN kinds use the curated preambles above. Any other kind is an
 * app-defined surface and must carry its own `preamble` — it is templated with
 * `{{targetId}}` / `{{snapshot}}` (so a surface registered before its record
 * exists still names the right id), and its declared `tools` are appended as a
 * plain instruction line. Naming tools is ADVISORY: Core's chat stream takes no
 * per-request allowlist, so this steers the model, it does not gate it.
 *
 * An app-defined kind with no preamble falls back to a neutral one rather than
 * silently borrowing the workflow builder's instructions.
 */
export function buildBuilderPreamble(
	session: Pick<
		AssistantBuilderSession,
		"kind" | "preamble" | "targetName" | "tools"
	>,
	targetId: string,
	snapshot: string
): string {
	if (session.kind === "agent") {
		return agentPreamble(targetId, snapshot);
	}
	if (session.kind === "workflow") {
		return workflowPreamble(targetId, snapshot);
	}
	const body = session.preamble
		? session.preamble
				.replaceAll("{{targetId}}", targetId)
				.replaceAll("{{snapshot}}", snapshot)
		: appSurfaceFallback(session.targetName || session.kind, targetId);
	const tools = session.tools?.filter((t) => t.trim().length > 0) ?? [];
	const toolLine =
		tools.length > 0
			? `\n\nUse these tools to act on it: ${tools.join(", ")}. Only call a tool that actually exists.`
			: "";
	// A custom preamble that never mentioned the snapshot still gets it — the
	// surface published it for a reason.
	// An empty snapshot adds nothing: bridge surfaces and pages that share their
	// state through removable page context pass "".
	const snapshotLine =
		session.preamble?.includes("{{snapshot}}") || !snapshot.trim()
			? ""
			: `\n\nCurrent state:\n${snapshot}`;
	return `${body}${toolLine}${snapshotLine}`;
}

/** Neutral instructions for an app-defined surface that registered without a
 *  preamble — better than borrowing another builder's wording. */
function appSurfaceFallback(name: string, targetId: string): string {
	return [
		`You are helping the user with "${name}" (id "${targetId}") inside Ryu.`,
		"Answer about what they currently have open, and make the changes they ask",
		"for using the tools available to you. Keep replies short and confirm what",
		"changed.",
	].join(" ");
}

/** Prepend the preamble to the first user message's first text part (outgoing only). */
export function injectPreamble(
	messages: UIMessage[],
	preamble: string
): UIMessage[] {
	let injected = false;
	return messages.map((message) => {
		if (injected || message.role !== "user") {
			return message;
		}
		injected = true;
		let textDone = false;
		const parts = message.parts.map((part) => {
			if (!textDone && part.type === "text") {
				textDone = true;
				return { ...part, text: `${preamble}\n\nUser: ${part.text}` };
			}
			return part;
		});
		return { ...message, parts };
	});
}
