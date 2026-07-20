import type { ComposerSettingItem } from "@/components/agent-elements/input/composer-settings-menu.tsx";

/** Human labels for Pi provider ids (mirrors Core `pi_config::PROVIDERS`). */
const PI_PROVIDER_LABELS: Record<string, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	google: "Google Gemini",
	deepseek: "DeepSeek",
	groq: "Groq",
	mistral: "Mistral",
	xai: "xAI",
	cerebras: "Cerebras",
	fireworks: "Fireworks AI",
	together: "Together AI",
	nvidia: "NVIDIA NIM",
	moonshot: "Moonshot AI",
	openrouter: "OpenRouter",
	gateway: "Ryu Gateway",
	"openai-codex": "ChatGPT (Plus/Pro)",
	"claude-pro-max": "Claude (Pro/Max)",
	"github-copilot": "GitHub Copilot",
	"ryu-openrouter": "Ryu (managed)",
};

export interface ModelMenuOption extends ComposerSettingItem {
	group: string | null;
}

export function providerLabel(providerId: string): string {
	const key = providerId.trim().toLowerCase();
	return PI_PROVIDER_LABELS[key] ?? titleCaseProvider(key);
}

function titleCaseProvider(id: string): string {
	return id
		.split(/[-_]/g)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/** Infer a provider section from a Pi-style `provider/model` id, else Local. */
export function inferModelGroup(modelId: string): string {
	const slash = modelId.indexOf("/");
	if (slash > 0) {
		return providerLabel(modelId.slice(0, slash));
	}
	return "Local";
}

/** Attach provider (or Local) group headers to flat model rows. */
export function groupModelItems(
	items: ComposerSettingItem[]
): ModelMenuOption[] {
	return items.map((item) => ({
		...item,
		group: inferModelGroup(item.id),
	}));
}

/** Merge installed local model stems into a model list (ryu / gateway picks). */
export function mergeInstalledModels(
	items: ComposerSettingItem[],
	installedStems: string[],
	activeStem?: string | null
): ComposerSettingItem[] {
	const seen = new Set(items.map((item) => item.id));
	const out = [...items];
	const push = (id: string, name: string) => {
		if (!id || seen.has(id)) {
			return;
		}
		seen.add(id);
		out.unshift({ id, name });
	};

	if (activeStem) {
		push(activeStem, activeStem);
	}
	for (const stem of installedStems) {
		push(stem, stem);
	}
	return out;
}

/** Sort groups: Local first, then alphabetical provider names. */
export function sortModelGroups(
	groups: { label: string | null; items: ModelMenuOption[] }[]
): { label: string | null; items: ModelMenuOption[] }[] {
	const rank = (label: string | null): number => {
		if (label === "Local") {
			return 0;
		}
		return 1;
	};
	return [...groups].sort((a, b) => {
		const ra = rank(a.label);
		const rb = rank(b.label);
		if (ra !== rb) {
			return ra - rb;
		}
		const la = a.label ?? "";
		const lb = b.label ?? "";
		return la.localeCompare(lb);
	});
}
