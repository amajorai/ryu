// Swappable AI backend for the editor's inline AI (Cmd+J menu: continue writing,
// improve, fix grammar, summarize, change tone) and copilot autocomplete.
//
// `@ryu/ui` stays agnostic of where the model lives: the host app (desktop)
// registers the Gateway's OpenAI-compatible base URL + the chosen model. Every
// editor model call then routes through Ryu's Gateway (the moat: routing /
// firewall / budgets / audit), honoring "nothing hardcoded". When unconfigured,
// the editor falls back to its built-in mock stream so it still works offline.

export interface EditorAiConfig {
	/**
	 * Optional id of the agent backing the editor AI. The host app resolves the
	 * agent's model into `model`; this id is also forwarded to the Gateway (as the
	 * `x-ryu-agent-id` header) so per-agent routing / budgets / audit can apply.
	 */
	agentId?: string;
	apiKey?: string;
	/** Gateway OpenAI-compatible base, e.g. `http://127.0.0.1:7981/v1`. */
	baseUrl: string | null;
	/** When false (or baseUrl null), the editor uses its mock stream. */
	enabled: boolean;
	headers?: Record<string, string>;
	/** Model id the Gateway should route to (e.g. the local default chat model). */
	model: string;
}

let config: EditorAiConfig = {
	baseUrl: null,
	model: "",
	enabled: false,
};

/** Host apps configure the editor's AI here. Partial-merges into current config. */
export function setEditorAiConfig(partial: Partial<EditorAiConfig>): void {
	config = { ...config, ...partial };
}

/** The editor's chat transport reads the active config through this. */
export function getEditorAiConfig(): EditorAiConfig {
	return config;
}
