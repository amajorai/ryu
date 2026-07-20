// "Get started" mini-quests: a small, app-state-driven onboarding checklist
// surfaced on the home tab and in the sidebar. Completion is *detected* (sticky)
// rather than manually ticked, so it reads like a quest log, not a todo list.
//
// Two completion sources merge:
//   - a real live signal where one exists (e.g. "send a message" -> a chat exists)
//   - otherwise a "did the action" flag stamped when the quest's CTA is followed.
// Both are persisted so a quest never un-checks itself (deleting your only chat
// should not reopen "Send your first message").

import {
	AiBrain01Icon,
	BubbleChatIcon,
	CpuIcon,
	Mortarboard01Icon,
	SlidersHorizontalIcon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

export type QuestStatus = "pending" | "in_progress" | "completed";

export interface GettingStartedQuest {
	/** One-line title shown in the checklist. */
	content: string;
	/** CTA button label. */
	cta: string;
	/** Short helper sentence shown under the next-step CTA. */
	description: string;
	/** Open a brand-new tab instead of reusing a singleton (chat only). */
	forceNew?: boolean;
	/** Topic glyph shown inside the checklist status circle. */
	icon: IconSvgElement;
	/** Stable id, also the localStorage key. */
	id: string;
	/** Tab route opened when the quest is followed. */
	path: string;
}

// Keep this short (5-6). The order is the suggested journey through Ryu.
export const GETTING_STARTED_QUESTS: GettingStartedQuest[] = [
	{
		id: "chat",
		content: "Send your first message",
		description: "Chat with Ryu to see an agent in action.",
		cta: "Start a chat",
		icon: BubbleChatIcon,
		path: "/chat",
		forceNew: true,
	},
	{
		id: "agent",
		content: "Explore the agents",
		description: "Pick an agent or build your own from swappable slots.",
		cta: "Browse agents",
		icon: AiBrain01Icon,
		path: "/library/agent",
	},
	{
		id: "model",
		content: "Install a local model",
		description: "Run fully local and private with a model of your choice.",
		cta: "Open the model store",
		icon: CpuIcon,
		path: "/models",
	},
	{
		id: "skill",
		content: "Add a skill",
		description: "Give your agents new abilities from the skills catalog.",
		cta: "Browse skills",
		icon: Mortarboard01Icon,
		path: "/skills",
	},
	{
		id: "workflow",
		content: "Build a workflow",
		description: "Chain agents and tools into a repeatable automation.",
		cta: "Open workflows",
		icon: WorkflowCircle06Icon,
		path: "/library/workflow",
	},
	{
		id: "customize",
		content: "Customize your Ryu",
		description: "Make Ryu yours — tune the sidebar, theme, and layout.",
		cta: "Open Customize",
		icon: SlidersHorizontalIcon,
		path: "/store",
	},
];

const STORAGE_KEY = "ryu:getting-started";

/** Fired whenever the completed set changes, so every surface stays in sync. */
export const GETTING_STARTED_EVENT = "ryu:getting-started-changed";

interface Persisted {
	completed: string[];
}

function readStorage(): string[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return [];
		}
		const parsed = JSON.parse(raw) as Persisted;
		return Array.isArray(parsed.completed) ? parsed.completed : [];
	} catch {
		// Corrupt or unavailable storage: treat as a fresh start.
		return [];
	}
}

// In-memory cache with a stable reference, so React's useSyncExternalStore can
// read it without spinning (a fresh array each read would loop forever).
let cache: string[] = readStorage();

const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) {
		listener();
	}
	// Cross-surface (and cross-window) nudge for anything not subscribed directly.
	window.dispatchEvent(new Event(GETTING_STARTED_EVENT));
}

function writeStorage(ids: string[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ completed: ids }));
	} catch {
		// Best-effort: keep the in-memory cache even if persistence fails.
	}
}

/** Stable snapshot for useSyncExternalStore. */
export function getCompletedSnapshot(): string[] {
	return cache;
}

export function subscribeGettingStarted(callback: () => void): () => void {
	listeners.add(callback);
	const onStorage = (event: StorageEvent) => {
		if (event.key === STORAGE_KEY) {
			cache = readStorage();
			callback();
		}
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(callback);
		window.removeEventListener("storage", onStorage);
	};
}

/** Mark a quest done. No-op if already complete. Sticky and persisted. */
export function markQuestComplete(id: string): void {
	if (cache.includes(id)) {
		return;
	}
	cache = [...cache, id];
	writeStorage(cache);
	notify();
}

/** Clear all progress (used by a "reset" affordance / tests). */
export function resetGettingStarted(): void {
	if (cache.length === 0) {
		return;
	}
	cache = [];
	writeStorage(cache);
	notify();
}
