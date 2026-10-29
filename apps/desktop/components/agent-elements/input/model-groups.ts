import type { ComposerSettingItem } from "@/components/agent-elements/input/composer-settings-menu.tsx";

/** Human labels for Pi provider ids (mirrors Core `pi_config::PROVIDERS`). */
const PI_PROVIDER_LABELS = new Map<string, string>([
	["anthropic", "Anthropic"],
	["openai", "OpenAI"],
	["google", "Google Gemini"],
	["deepseek", "DeepSeek"],
	["groq", "Groq"],
	["mistral", "Mistral"],
	["xai", "xAI"],
	["cerebras", "Cerebras"],
	["fireworks", "Fireworks AI"],
	["together", "Together AI"],
	["nvidia", "NVIDIA NIM"],
	["moonshot", "Moonshot AI"],
	["openrouter", "OpenRouter"],
	["gateway", "Ryu Gateway"],
	["openai-codex", "ChatGPT (Plus/Pro)"],
	["chatgpt", "ChatGPT (native)"],
	["claude-pro-max", "Claude (Pro/Max)"],
	["github-copilot", "GitHub Copilot"],
	["ryu-openrouter", "Ryu Router"],
]);

export interface ModelMenuOption extends ComposerSettingItem {
	group: string | null;
}

export function providerLabel(providerId: string): string {
	const key = providerId.trim().toLowerCase();
	return PI_PROVIDER_LABELS.get(key) ?? titleCaseProvider(key);
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

/**
 * Weights on disk that are NOT chat models, matched on the local stem.
 *
 * `/api/models/installed` is the flat inventory of everything the node
 * downloaded, which includes the support models Core installs on its own:
 * the nomic embedder (RAG), the bge reranker, and the STT/TTS weights. None of
 * them can serve a turn — offering one as a chat model produces a model the
 * engine will refuse to load, so they are filtered wherever the composer offers
 * a local model to CHAT with. Everything else is offered; whether the engine can
 * actually run it stays Core's call (`setActiveModel` rejects and toasts), since
 * only Core knows which runtimes exist on this machine.
 *
 * Deliberately a name rule rather than a Core field: the inventory carries no
 * role, and every one of these families names itself in the file it ships as.
 *
 * Every token here is a distinctive family name, because these are substring
 * matches and the cost of a false positive is silent: the model simply is not in
 * the list and nothing says why. `clip` and `vae` were tried and removed for
 * exactly that reason — they swallow `Eclipse-13B` and `Vaelora-7B` — and the
 * image models they were meant to catch are not served through this path at all.
 */
const NON_CHAT_STEM = /embed|rerank|whisper|parakeet|kokoro|silero/i;

/** True when an installed weight can plausibly serve a chat turn. */
export function isChatModelStem(stem: string): boolean {
	return stem !== "" && !NON_CHAT_STEM.test(stem);
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

	// The active stem is pushed unfiltered: whatever the node is actually serving
	// must stay visible, or the picker renders a selection it cannot show.
	if (activeStem) {
		push(activeStem, activeStem);
	}
	for (const stem of installedStems.filter(isChatModelStem)) {
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
