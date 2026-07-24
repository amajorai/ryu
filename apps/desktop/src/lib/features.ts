// Optional, user-facing "features" the app can turn on or off. Most features map
// 1:1 to a sidebar section (by key); a few map to header chrome buttons (e.g.
// Fine-tune). "Disabling a feature" hides that section or button from the sidebar,
// so this module is a thin, friendly layer over the sidebar's hidden-sections
// (`ryu:sidebar-hidden-sections`) and hidden-chrome (`ryu:sidebar-hidden-chrome`)
// stores. Those keys are the single source of truth — the Onboarding "features"
// step, the Settings → Features tab, and the sidebar's own Customize dialog all
// read and write the same sets.
//
// This module is one-directional on purpose: it owns the storage key, the change
// event, the load/persist helpers, and the feature catalog, all keyed by plain
// strings. `AppSidebar.tsx` imports *from here*; nothing here imports the sidebar's
// `SectionKey` type, so there is no import cycle.

import { useEffect, useState } from "react";
import { track } from "@/src/lib/analytics.ts";

/** localStorage key holding the JSON array of hidden sidebar section keys. */
export const SECTION_HIDDEN_KEY = "ryu:sidebar-hidden-sections";

/** localStorage key holding the JSON array of hidden sidebar chrome keys. */
export const CHROME_HIDDEN_KEY = "ryu:sidebar-hidden-chrome";

/** localStorage key recording which default-hidden sections have already been
 *  seeded into the hidden set, so each is hidden exactly once (see
 *  {@link seedDefaultHiddenSections}) and a later un-hide is never undone. */
const HIDDEN_SEEDED_KEY = "ryu:sidebar-hidden-seeded";

/** Same as {@link HIDDEN_SEEDED_KEY} but for chrome-backed features. */
const CHROME_HIDDEN_SEEDED_KEY = "ryu:sidebar-hidden-chrome-seeded";

// Sections that start hidden until the user opts in (via the sidebar Customize
// dialog or Settings → Features). Unlike the always-visible built-ins, these are
// seeded into the hidden set the first time each is seen, so both fresh and
// existing installs get them hidden once while an un-hide sticks.
export const DEFAULT_HIDDEN_SECTIONS = [
	"channels",
	"integrations",
	"identities",
	"skills",
	"mcp",
	"plugins",
	"companions",
	"engines",
] as const;

// Header chrome buttons that start hidden until the user opts in. (Empty: Memory is
// no longer a hardcoded chrome button — it's app-registered by com.ryu.memory via a
// `sidebar_buttons` contribution, so its visibility follows that app's enabled state.)
export const DEFAULT_HIDDEN_CHROME = [] as const;

/** Window event fired whenever the hidden-sections set changes, so every mounted
 *  surface (sidebar, settings tab) re-syncs from storage. */
export const FEATURES_CHANGED_EVENT = "ryu:features-changed";

/** Where a toggleable feature lives in the sidebar chrome. */
export type FeatureSurface = "section" | "chrome";

/** A toggleable feature, shown as one row in onboarding and Settings → Features. */
export interface FeatureDef {
	/** One line on what the feature is for — shown beside the toggle. */
	description: string;
	/** Sidebar section or header chrome key; disabling adds it to the hidden set. */
	key: string;
	name: string;
	/** Defaults to `"section"`. Chrome-backed features hide a nav button instead. */
	surface?: FeatureSurface;
}

// The clearly-optional features. Agents/Chats/Tabs stay out of this list — they're
// core to an agent app — and remain reachable via the full Customize dialog.
export const TOGGLEABLE_FEATURES: FeatureDef[] = [
	{
		key: "meetings",
		name: "Meetings",
		description:
			"Record calls and get AI-written notes, with automatic meeting detection.",
	},
	{
		key: "teams",
		name: "Agent Teams",
		description:
			"Group several agents so they answer together, debate, or route to the best one.",
	},
	{
		key: "spaces",
		name: "Spaces",
		description:
			"Knowledge bases your agents can search and cite, built from your documents and notes.",
	},
	{
		key: "workflows",
		name: "Workflows",
		description:
			"Automate multi-step tasks on a visual canvas, with schedules and triggers.",
	},
	{
		key: "channels",
		name: "Channels",
		description:
			"Run your agents as Telegram, Slack, WhatsApp, and Discord bots.",
	},
	{
		key: "integrations",
		name: "Integrations",
		description:
			"Connect Gmail, GitHub, Slack, and 800+ apps for your agents to act on.",
	},
	{
		key: "identities",
		name: "Identities",
		description:
			"Saved logins your agents can reuse to stay signed in to the sites they use.",
	},
	{
		key: "skills",
		name: "Skills",
		description:
			"Installed agent skills that teach your agents new procedures and know-how.",
	},
	{
		key: "mcp",
		name: "MCP Servers",
		description:
			"Model Context Protocol servers that expose extra tools to your agents.",
	},
	{
		key: "plugins",
		name: "Plugins",
		description:
			"Browse, install, and manage plugin apps that add tools and capabilities.",
	},
	{
		key: "companions",
		name: "Apps",
		description:
			"Full-page app surfaces from your enabled plugins, listed in the sidebar.",
	},
	{
		key: "engines",
		name: "Engines",
		description:
			"Local inference engines installed on this node (llama.cpp, Ollama, …).",
	},
];

function featureSurface(key: string): FeatureSurface {
	return (
		TOGGLEABLE_FEATURES.find((feature) => feature.key === key)?.surface ??
		"section"
	);
}

/** Read the current hidden-sections set fresh from storage. */
export function loadHiddenSections(): Set<string> {
	try {
		const stored = localStorage.getItem(SECTION_HIDDEN_KEY);
		return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
	} catch {
		return new Set();
	}
}

/** Persist the hidden-sections set and notify every mounted surface to re-sync. */
export function persistHiddenSections(hidden: Set<string>) {
	try {
		localStorage.setItem(SECTION_HIDDEN_KEY, JSON.stringify([...hidden]));
	} catch {
		// best-effort; still notify so in-memory state stays consistent
	}
	window.dispatchEvent(new CustomEvent(FEATURES_CHANGED_EVENT));
}

/**
 * Seed the {@link DEFAULT_HIDDEN_SECTIONS} into the hidden set once each. A
 * section is added only the first time it's ever seen (recorded in
 * `HIDDEN_SEEDED_KEY`), so both new and existing installs get it hidden once
 * while a user's later un-hide is never re-applied. Idempotent and best-effort;
 * writes storage directly (no change event — callers read the fresh set on
 * mount). Run at module load so every surface (sidebar, onboarding, Settings →
 * Features) observes the seeded set before it first reads the hidden sections.
 */
export function seedDefaultHiddenSections(): void {
	try {
		const seededRaw = localStorage.getItem(HIDDEN_SEEDED_KEY);
		const seeded = new Set<string>(
			seededRaw ? (JSON.parse(seededRaw) as string[]) : []
		);
		const toSeed = DEFAULT_HIDDEN_SECTIONS.filter((k) => !seeded.has(k));
		if (toSeed.length === 0) {
			return;
		}
		const hidden = loadHiddenSections();
		for (const key of toSeed) {
			hidden.add(key);
			seeded.add(key);
		}
		localStorage.setItem(SECTION_HIDDEN_KEY, JSON.stringify([...hidden]));
		localStorage.setItem(HIDDEN_SEEDED_KEY, JSON.stringify([...seeded]));
	} catch {
		// best-effort; a fresh set will simply show the sections until next run
	}
}

seedDefaultHiddenSections();

/** Read the current hidden-chrome set fresh from storage. */
export function loadHiddenChrome(): Set<string> {
	try {
		const stored = localStorage.getItem(CHROME_HIDDEN_KEY);
		return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
	} catch {
		return new Set();
	}
}

/** Persist the hidden-chrome set and notify every mounted surface to re-sync. */
export function persistHiddenChrome(hidden: Set<string>) {
	try {
		localStorage.setItem(CHROME_HIDDEN_KEY, JSON.stringify([...hidden]));
	} catch {
		// best-effort; still notify so in-memory state stays consistent
	}
	window.dispatchEvent(new CustomEvent(FEATURES_CHANGED_EVENT));
}

/**
 * Seed {@link DEFAULT_HIDDEN_CHROME} into the hidden set once each. Mirrors
 * {@link seedDefaultHiddenSections}.
 */
export function seedDefaultHiddenChrome(): void {
	try {
		const seededRaw = localStorage.getItem(CHROME_HIDDEN_SEEDED_KEY);
		const seeded = new Set<string>(
			seededRaw ? (JSON.parse(seededRaw) as string[]) : []
		);
		const toSeed = DEFAULT_HIDDEN_CHROME.filter((k) => !seeded.has(k));
		if (toSeed.length === 0) {
			return;
		}
		const hidden = loadHiddenChrome();
		for (const key of toSeed) {
			hidden.add(key);
			seeded.add(key);
		}
		localStorage.setItem(CHROME_HIDDEN_KEY, JSON.stringify([...hidden]));
		localStorage.setItem(CHROME_HIDDEN_SEEDED_KEY, JSON.stringify([...seeded]));
	} catch {
		// best-effort
	}
}

seedDefaultHiddenChrome();

/** Whether a feature is currently enabled (i.e. not hidden in its surface store). */
export function isFeatureEnabled(key: string): boolean {
	if (featureSurface(key) === "chrome") {
		return !loadHiddenChrome().has(key);
	}
	return !loadHiddenSections().has(key);
}

/**
 * Enable or disable a feature. Always loads the set fresh before mutating, so a
 * concurrent writer (e.g. the sidebar Customize dialog open at the same time as
 * this Settings tab) can't be clobbered by a stale React snapshot.
 */
export function setFeatureEnabled(key: string, enabled: boolean) {
	if (featureSurface(key) === "chrome") {
		const hidden = loadHiddenChrome();
		if (enabled) {
			hidden.delete(key);
		} else {
			hidden.add(key);
		}
		persistHiddenChrome(hidden);
	} else {
		const hidden = loadHiddenSections();
		if (enabled) {
			hidden.delete(key);
		} else {
			hidden.add(key);
		}
		persistHiddenSections(hidden);
	}
	track(
		enabled
			? { event: "feature_enabled", section: key }
			: { event: "feature_disabled", section: key }
	);
}

/**
 * Subscribe to feature visibility. Stays in sync across surfaces via the change
 * event (same tab) and the `storage` event (other windows).
 */
export function useFeatureToggles(): {
	isEnabled: (key: string) => boolean;
	setEnabled: (key: string, enabled: boolean) => void;
} {
	const [revision, setRevision] = useState(0);

	useEffect(() => {
		const resync = () => setRevision((value) => value + 1);
		window.addEventListener(FEATURES_CHANGED_EVENT, resync);
		window.addEventListener("storage", resync);
		return () => {
			window.removeEventListener(FEATURES_CHANGED_EVENT, resync);
			window.removeEventListener("storage", resync);
		};
	}, []);

	return {
		isEnabled: (key) => {
			void revision;
			return isFeatureEnabled(key);
		},
		setEnabled: (key, enabled) => {
			setFeatureEnabled(key, enabled);
			setRevision((value) => value + 1);
		},
	};
}
