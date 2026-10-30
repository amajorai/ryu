import type { GatewayCliTool } from "@/src/lib/api/cli-setup.ts";
import type { GatewayClientOperation } from "@/src/lib/api/gateway.ts";

export const COPIED_RESET_MS = 1500;
export const CLIENT_OPERATIONS: {
	id: GatewayClientOperation;
	label: string;
}[] = [
	{ id: "inference", label: "LLM, embeddings & media" },
	{ id: "web_search", label: "Web search" },
	{ id: "web_fetch", label: "Web fetch" },
];

export const CLI_TOOLS: { id: GatewayCliTool; label: string }[] = [
	{ id: "claude-code", label: "Claude Code" },
	{ id: "codex", label: "Codex CLI" },
	{ id: "opencode", label: "OpenCode" },
	{ id: "gemini-cli", label: "Gemini CLI" },
	{ id: "pi", label: "Pi" },
	{ id: "droid", label: "Factory Droid" },
	{ id: "openclaw", label: "OpenClaw" },
	{ id: "hermes", label: "Hermes Agent" },
	{ id: "continue", label: "Continue" },
	{ id: "kilo", label: "Kilo Code" },
	{ id: "cline", label: "Cline CLI" },
	{ id: "iflow", label: "iFlow CLI" },
	{ id: "qwen-code", label: "Qwen Code" },
];
