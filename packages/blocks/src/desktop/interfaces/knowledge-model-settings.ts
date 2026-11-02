import type { KnowledgeNode } from "./knowledge-model.ts";

/** Knowledge view settings and node sizes. */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface KnowledgeSettings {
	agents: boolean;
	/** Center force, 0..1. */
	centerForce: number;
	conversations: boolean;
	depth: 1 | 2;
	groups: boolean;
	/** Link distance in world units. */
	linkDistance: number;
	/** Link force, 0..1. */
	linkForce: number;
	/** Link thickness in CSS pixels. */
	linkWidth: number;
	/**
	 * Topics also link conversations whose latest message contains a title
	 * word. Off by default: topics come from titles alone.
	 */
	messages: boolean;
	mode: "global" | "local";
	/** Node size multiplier. */
	nodeSize: number;
	orphans: boolean;
	/** Repel force, 0..1. */
	repelForce: number;
	/** Text fade threshold, 0..1: higher keeps labels until zoomed further out. */
	textFade: number;
	topics: boolean;
}

export const DEFAULT_SETTINGS: KnowledgeSettings = {
	agents: true,
	centerForce: 0.5,
	conversations: true,
	depth: 1,
	groups: true,
	linkDistance: 30,
	linkForce: 0.6,
	linkWidth: 1,
	messages: false,
	mode: "global",
	nodeSize: 1,
	orphans: true,
	repelForce: 0.5,
	textFade: 0.5,
	topics: true,
};

/**
 * The panel's settings from the interface's live params (any missing key at
 * its default), so a choice saved through `updateSettings` comes back.
 */
export function settingsFromParams(
	params: Partial<Record<keyof KnowledgeSettings, unknown>> | undefined
): KnowledgeSettings {
	const out: KnowledgeSettings = { ...DEFAULT_SETTINGS };
	for (const key of Object.keys(
		DEFAULT_SETTINGS
	) as (keyof KnowledgeSettings)[]) {
		const value = params?.[key];
		if (typeof value === typeof DEFAULT_SETTINGS[key]) {
			(out as unknown as Record<string, unknown>)[key] = value;
		}
	}
	out.depth = out.depth === 2 ? 2 : 1;
	return out;
}

/** Whether two settings objects hold the same values. */
export function sameSettings(
	a: KnowledgeSettings,
	b: KnowledgeSettings
): boolean {
	return (Object.keys(a) as (keyof KnowledgeSettings)[]).every(
		(key) => a[key] === b[key]
	);
}

export interface ForceSettings {
	/**
	 * Height over width of the room the graph is shown in. Gravity pulls the
	 * short axis harder, so a portrait stage gets a tall graph that fills it.
	 */
	aspect?: number;
	centerForce: number;
	linkDistance: number;
	linkForce: number;
	repelForce: number;
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/** Node radius in world units (before the node size setting). */
export function nodeRadius(node: KnowledgeNode): number {
	const links = Math.sqrt(node.degree);
	switch (node.kind) {
		case "project":
		case "team":
			return 6.6 + links * 0.8;
		case "agent":
			return 5.8 + links * 0.7;
		case "topic":
			return 3.6 + links * 0.5;
		default:
			return 3 + Math.min(2, Math.log2(1 + node.weight) * 0.45);
	}
}
