// Pure account-access helpers shared by the native app, the CLI and desktop:
// the allowlist key grammar, saved-key detection, the BYOK provider list and
// the vendor an agent engine calls itself. Each keeps in step with the Core
// code named on it.

/** The Treg switch's allowlist key. */
export const TREG_ACCOUNT_KEY = "platform:treg";
/** Ghost controlling your desktop, and what Shadow captured from it. */
export const DESKTOP_ACCOUNT_KEY = "platform:desktop";

/** Account-key builders. Keep in step with `apps/core/src/agent_access.rs`. */
export const accountKey = {
	agent: (vaultAccountId: string) => `agent:${vaultAccountId}`,
	/** An app connected to the agent's own Composio identity. */
	agentComposio: (connectedAccountId: string) =>
		`agent-composio:${connectedAccountId}`,
	composio: (connectedAccountId: string) => `composio:${connectedAccountId}`,
	desktop: DESKTOP_ACCOUNT_KEY,
	mcp: (profileId: string, pluginId: string, serverName: string) =>
		`mcp:${profileId}:${pluginId}:${serverName}`,
	/** A model provider, by its Gateway registry id (Gemini is `genai`). */
	provider: (registryId: string) => `provider:${registryId}`,
	/** An MCP server or app's tools that use one of your saved keys. */
	savedKey: (serverOrPluginId: string) => `mcp-secret:${serverOrPluginId}`,
	treg: TREG_ACCOUNT_KEY,
} as const;

const WHITESPACE = /\s+/;

/**
 * Whether a header or env source names one of your saved keys. Keep in step
 * with `source_references_user_secret` in `apps/core/src/sidecar/mcp/mod.rs`:
 * `env:RYU_TOKEN` is Ryu's own agent token, not one of your keys.
 */
export function sourceReferencesSavedKey(value: string): boolean {
	return value
		.split(WHITESPACE)
		.some(
			(word) =>
				word.startsWith("secret:") ||
				word.startsWith("vault:") ||
				(word.startsWith("env:") && word !== "env:RYU_TOKEN")
		);
}

function stringValues(value: unknown): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return [];
	}
	return Object.values(value).filter(
		(entry): entry is string => typeof entry === "string"
	);
}

/** Whether an app's own tools call out with one of your saved keys. */
export function appUsesSavedKeys(
	runnables: readonly { config?: unknown; kind?: string }[]
): boolean {
	return runnables.some((runnable) => {
		const config = runnable.config;
		if (
			runnable.kind !== "tool" ||
			!config ||
			typeof config !== "object" ||
			Array.isArray(config)
		) {
			return false;
		}
		const fields = config as Record<string, unknown>;
		return [
			...stringValues(fields.secret_headers),
			...stringValues(fields.env),
		].some(sourceReferencesSavedKey);
	});
}

/**
 * The BYOK model providers whose keys count as your accounts, in desktop's
 * order. Desktop keeps a `ByokProvider`-typed copy in
 * `apps/desktop/src/components/agents/agent-provider-access.ts`; its test
 * asserts the two lists match.
 */
export const BYOK_MODEL_PROVIDERS: readonly { label: string; slug: string }[] =
	[
		{ slug: "openai", label: "OpenAI" },
		{ slug: "anthropic", label: "Anthropic" },
		{ slug: "openrouter", label: "OpenRouter" },
		{ slug: "gemini", label: "Gemini" },
		{ slug: "mistral", label: "Mistral" },
		{ slug: "huggingface", label: "Hugging Face" },
		{ slug: "nvidia", label: "NVIDIA NIM" },
		{ slug: "together", label: "Together AI" },
		{ slug: "fireworks", label: "Fireworks AI" },
		{ slug: "qwen", label: "Qwen" },
		{ slug: "modal", label: "Modal" },
	];

/** Other OpenAI-compatible chat providers, by Gateway id. */
export const COMPATIBLE_CHAT_PROVIDERS: Readonly<Record<string, string>> = {
	chutes: "Chutes",
	featherless: "Featherless",
	hyperbolic: "Hyperbolic",
	siliconflow: "SiliconFlow",
	venice: "Venice",
};

/** The Gateway registry id a BYOK key is served under. */
export function byokProviderRegistryId(slug: string): string {
	return slug === "gemini" ? "genai" : slug;
}

const PATH_SEPARATOR = /[\\/]/;
const QUOTES = /^["']|["']$/g;

/** The file name of `word` without its directory or extension, lowercased. */
function commandStem(word: string): string {
	const name = word.split(PATH_SEPARATOR).at(-1) ?? "";
	const dot = name.lastIndexOf(".");
	return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

/**
 * Whether a BYO command launches `binary`: as the program, or as a script path
 * handed to a runtime such as `node`. Mirrors `launches_gemini_cli` /
 * `launches_kiro_cli` in `apps/core/src/acp_agent_settings.rs`.
 */
function commandLaunches(command: string, binary: string): boolean {
	const [program, ...args] = command
		.split(WHITESPACE)
		.filter(Boolean)
		.map((word) => word.replace(QUOTES, ""));
	if (program !== undefined && commandStem(program) === binary) {
		return true;
	}
	return args.some(
		(word) => PATH_SEPARATOR.test(word) && commandStem(word) === binary
	);
}

/** A model provider by its Gateway registry id, with a readable label. */
export interface EngineModelProvider {
	id: string;
	label: string;
}

/**
 * The vendor an agent engine calls itself with your own sign-in or key: the
 * row Core requires before a limited agent may start it
 * (`route_provider_reach` in `apps/core/src/sidecar/adapters/mod.rs`; keep
 * the two in step). A BYO `acp-exec:` command is recognised by what it runs.
 * Engines that go through Ryu's Gateway, and Ryu's own engine, have no row.
 */
export function engineModelProvider(
	engine: string | null
): EngineModelProvider | null {
	if (!engine) {
		return null;
	}
	const command = engine.startsWith("acp-exec:")
		? engine.slice("acp-exec:".length).toLowerCase()
		: null;
	if (
		engine === "acp:claude" ||
		command?.includes("claude-agent-acp") ||
		command?.includes("claude-code-acp")
	) {
		return {
			id: "anthropic",
			label: "Anthropic (Claude Code's own sign-in or key)",
		};
	}
	if (engine === "acp:codex" || command?.includes("codex-acp")) {
		return { id: "openai", label: "OpenAI (Codex's ChatGPT sign-in or key)" };
	}
	if (
		engine === "acp:gemini" ||
		command?.includes("@google/gemini-cli") ||
		(command !== null && commandLaunches(command, "gemini"))
	) {
		return {
			id: "genai",
			label: "Google Gemini (Gemini CLI's own sign-in or key)",
		};
	}
	if (
		engine === "acp:kiro" ||
		(command !== null && commandLaunches(command, "kiro-cli"))
	) {
		return { id: "kiro", label: "Kiro (Kiro CLI's sign-in)" };
	}
	return null;
}
