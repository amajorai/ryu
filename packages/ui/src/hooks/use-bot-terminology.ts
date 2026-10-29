import { useCallback, useSyncExternalStore } from "react";

/** The persisted desktop vocabulary switch. Only an explicit `false` opts out. */
export const BOT_TERMINOLOGY_STORAGE_KEY = "ryu:bot-terminology";
export const DEFAULT_BOT_TERMINOLOGY = true;

// An optional "an " before a singular agent, which becomes "a bot".
const AGENT_WORD_RE = /\b(?:(an) )?(agents?)\b/gi;
const listeners = new Set<() => void>();

function preserveCase(source: string, replacement: string): string {
	if (source === source.toUpperCase()) {
		return replacement.toUpperCase();
	}
	if (source === source.toLowerCase()) {
		return replacement.toLowerCase();
	}
	if (
		source[0] === source[0]?.toUpperCase() &&
		source.slice(1) === source.slice(1).toLowerCase()
	) {
		return `${replacement[0]?.toUpperCase() ?? ""}${replacement.slice(1)}`;
	}
	return replacement;
}

/**
 * Replace visible Agent/agent/Agents/agents words without maintaining a list of
 * every copy string. Word boundaries leave identifiers and names such as
 * `agentic` or `Agentation` unchanged, while punctuation and possessives keep
 * working naturally.
 */
export function replaceAgentTerms(text: string): string {
	return text.replace(
		AGENT_WORD_RE,
		(_match, article: string | undefined, word: string) => {
			const plural = word.toLowerCase().endsWith("s");
			const noun = preserveCase(word, plural ? "bots" : "bot");
			if (!article) {
				return noun;
			}
			// "an agent" reads "a bot", not "an bot".
			return plural
				? `${article} ${noun}`
				: `${preserveCase(article, "a")} ${noun}`;
		}
	);
}

/** Current preference, safe when storage is unavailable. */
export function readBotTerminology(): boolean {
	try {
		return localStorage.getItem(BOT_TERMINOLOGY_STORAGE_KEY) !== "false";
	} catch {
		return DEFAULT_BOT_TERMINOLOGY;
	}
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	const onStorage = (event: StorageEvent) => {
		if (event.key === BOT_TERMINOLOGY_STORAGE_KEY) {
			callback();
		}
	};
	if (globalThis.window !== undefined) {
		window.addEventListener("storage", onStorage);
	}
	return () => {
		listeners.delete(callback);
		if (globalThis.window !== undefined) {
			window.removeEventListener("storage", onStorage);
		}
	};
}

/** Persist the vocabulary choice and notify same-window consumers immediately. */
export function setBotTerminology(enabled: boolean): void {
	try {
		localStorage.setItem(
			BOT_TERMINOLOGY_STORAGE_KEY,
			enabled ? "true" : "false"
		);
	} catch {
		// Best-effort persistence; the in-memory listeners still update.
	}
	for (const callback of listeners) {
		callback();
	}
}

/** Non-React subscription for host surfaces that need the live preference. */
export function subscribeBotTerminology(
	callback: (enabled: boolean) => void
): () => void {
	const emit = () => callback(readBotTerminology());
	const dispose = subscribe(emit);
	emit();
	return dispose;
}

/** `[enabled, setEnabled]` for a shared, persisted, default-on preference. */
export function useBotTerminology(): [boolean, (enabled: boolean) => void] {
	const enabled = useSyncExternalStore(
		subscribe,
		readBotTerminology,
		() => DEFAULT_BOT_TERMINOLOGY
	);
	const setEnabled = useCallback((next: boolean) => {
		setBotTerminology(next);
	}, []);
	return [enabled, setEnabled];
}
