// apps/desktop/src/lib/cloud-agent-mode.ts
//
// The two kinds of cloud agent, named the same way everywhere in the UI and docs
// (see /docs/surfaces/desktop/user-guide/where-agents-run):
//
// - "Agent in the cloud": the agent loop itself runs remotely, inside a Ryu Box
//   (Claude Code, Codex, OpenCode or Cursor as the executor) or in the provider's
//   own cloud (`claude --cloud`, `codex cloud exec`).
// - "Agent on your computer": the agent loop, model calls and memory stay in Core on
//   your node; only the workspace (files, edits, commands) or the screen and browser
//   run in an isolated cloud Box.
//
// A plan backend that runs on the node itself is neither: nothing is sandboxed.

import type { CloudTaskBackendId } from "./api/cloud-task-backends.ts";

export type CloudAgentMode = "agent-in-cloud" | "agent-on-computer" | "on-node";

export const CLOUD_AGENT_MODE_LABELS: Record<CloudAgentMode, string> = {
	"agent-in-cloud": "Agent in the cloud",
	"agent-on-computer": "Agent on your computer",
	"on-node": "On this node, no sandbox",
};

/** The executors that run the provider's CLI on a personal Claude or ChatGPT plan. */
const PLAN_CLI_EXECUTORS = new Set(["claude-code", "codex"]);

/** Where the agent loop runs for a cloud-environment executor in a Ryu Box. */
export function executorAgentMode(executor: string): CloudAgentMode {
	return executor === "ryu" ? "agent-on-computer" : "agent-in-cloud";
}

/** Where the agent loop runs for a cloud-task backend and executor. */
export function backendAgentMode(
	backend: CloudTaskBackendId,
	executor: string
): CloudAgentMode {
	if (backend === "ryu-box") {
		return executorAgentMode(executor);
	}
	if (
		backend === "anthropic-subscription-sdk" ||
		backend === "openai-subscription-sdk"
	) {
		return "on-node";
	}
	return "agent-in-cloud";
}

/**
 * True when a personal Claude or ChatGPT plan could be used from a datacenter IP:
 * Claude Code or Codex inside a Ryu Box (a plan sign-in there leaves a cloud
 * server), or a plan run "on this node" when Ryu hosts the node. Runs in the
 * provider's own cloud are the provider's sanctioned path and return false.
 */
export function planFromDatacenter(
	backend: CloudTaskBackendId,
	executor: string,
	nodeManaged: boolean
): boolean {
	if (backend === "ryu-box") {
		return PLAN_CLI_EXECUTORS.has(executor);
	}
	return backendAgentMode(backend, executor) === "on-node" && nodeManaged;
}
