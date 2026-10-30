import type { SvglSpec } from "@ryu/blocks/web/svgl-icon.tsx";
import type {
	AgentSyncProfile,
	SyncProvider,
} from "@/src/lib/api/agent-sync.ts";

export interface ProviderOption {
	/** Home folder under `~` offered as a one-click scan; absent when the
	    source has no fixed home (an export download or a code project). */
	home?: string;
	label: string;
	/** Bundled brand mark (`/logos/<slug>.svg`). */
	logo: SvglSpec;
	value: SyncProvider;
}

export const PROVIDERS: ProviderOption[] = [
	{ label: "Claude", value: "claude", home: ".claude", logo: "claude" },
	{ label: "Codex", value: "codex", home: ".codex", logo: "codex" },
	{
		label: "Cursor",
		value: "cursor",
		home: ".cursor",
		logo: { light: "cursor_light", dark: "cursor_dark" },
	},
	{ label: "OpenClaw", value: "openclaw", home: ".openclaw", logo: "openclaw" },
	{
		label: "Hermes",
		value: "hermes",
		home: ".hermes",
		logo: { light: "hermes_light", dark: "hermes_dark" },
	},
	{
		label: "ChatGPT",
		value: "chatgpt",
		logo: { light: "openai", dark: "openai_dark" },
	},
	{ label: "Claude.ai", value: "claude-ai", logo: "claude" },
	{ label: "Muse", value: "muse", logo: "meta" },
	{
		label: "Dots",
		value: "persona",
		logo: { light: "openai", dark: "openai_dark" },
	},
	{
		label: "Mastra",
		value: "mastra",
		logo: { light: "mastra_light", dark: "mastra_dark" },
	},
	{ label: "LangChain", value: "langchain", logo: "langchain" },
];

/** Providers with a well-known home folder, offered as one-click scans. */
export const HOME_PROVIDERS = PROVIDERS.filter(
	(entry): entry is ProviderOption & { home: string } =>
		entry.home !== undefined
);

/** Where to point the root path for providers without a home folder. */
export const PROVIDER_ROOT_HINTS = new Map<SyncProvider, string>([
	["chatgpt", "/Users/you/Downloads/chatgpt-export"],
	["claude-ai", "/Users/you/Downloads/claude-export"],
	["muse", "/Users/you/Downloads/muse-export"],
	["persona", "/Users/you/my-dot"],
	["mastra", "/Users/you/code/mastra-app"],
	["langchain", "/Users/you/code/langgraph-app"],
]);

export function providerLabel(provider: SyncProvider): string {
	return PROVIDERS.find((entry) => entry.value === provider)?.label ?? provider;
}

export function pathSeparator(path: string): string {
	return path.includes("\\") ? "\\" : "/";
}

export function profileKey(profile: AgentSyncProfile): string {
	return `${profile.provider}:${profile.root}`;
}
