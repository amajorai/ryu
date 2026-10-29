// apps/desktop/src/lib/agent-mystery-box.ts
//
// The pure half of the Store's Agent Mystery Box: which agents can come out of a
// box, how one is drawn, and what "rarity" its card wears.
//
// The pool is everything in the Agents tab the user could still act on: runtimes
// that are available here and not yet added (never the built-in flagship, which
// is always installed), plus the published Agent Templates. A draw never repeats
// a card the user has already seen this session until the pool is exhausted —
// then the deck reshuffles, so the box never runs dry while anything is left.
//
// Rarity is cosmetic, but it is NOT made up: every tier is earned from a signal
// the catalog already carries (recommended, first-party/verified publisher,
// community rating, detected on this machine). A box can never claim an agent is
// rarer than the data says it is.

import type { AgentCatalogEntry } from "@/src/lib/api/agents.ts";
import type { MarketplaceCard } from "@/src/lib/api/marketplace.ts";

/** The built-in agent: always installed, so never a prize. */
export const MYSTERY_BOX_FLAGSHIP_ID = "ryu";

export type MysteryAgent =
	| { kind: "runtime"; entry: AgentCatalogEntry }
	| { kind: "template"; card: MarketplaceCard };

export type MysteryRarity = "common" | "rare" | "epic" | "legendary";

export interface MysteryRarityStyle {
	/** Glow, ribbon, and particle color of the box and card for this tier. */
	accent: string;
	label: string;
}

export const MYSTERY_RARITY_STYLES: Record<MysteryRarity, MysteryRarityStyle> =
	{
		common: { accent: "#94a3b8", label: "Common" },
		rare: { accent: "#38bdf8", label: "Rare" },
		epic: { accent: "#a855f7", label: "Epic" },
		legendary: { accent: "#f59e0b", label: "Legendary" },
	};

/** Minimum ratings before a template's average can earn it a tier. */
const MIN_RATINGS_FOR_TIER = 3;

export function mysteryAgentId(agent: MysteryAgent): string {
	return agent.kind === "runtime"
		? `runtime:${agent.entry.id}`
		: `template:${agent.card.id}`;
}

export function mysteryAgentName(agent: MysteryAgent): string {
	return agent.kind === "runtime" ? agent.entry.name : agent.card.name;
}

export function mysteryAgentDescription(agent: MysteryAgent): string | null {
	return agent.kind === "runtime"
		? agent.entry.description
		: agent.card.description;
}

/** Everything a box can contain, in catalog order. */
export function buildMysteryPool(
	runtimes: readonly AgentCatalogEntry[],
	templates: readonly MarketplaceCard[]
): MysteryAgent[] {
	const pool: MysteryAgent[] = [];
	for (const entry of runtimes) {
		if (
			entry.id !== MYSTERY_BOX_FLAGSHIP_ID &&
			entry.available &&
			!entry.added
		) {
			pool.push({ kind: "runtime", entry });
		}
	}
	for (const card of templates) {
		pool.push({ kind: "template", card });
	}
	return pool;
}

export interface MysteryDraw {
	agent: MysteryAgent;
	/** Ids seen so far, including this draw. Reset when the deck reshuffled. */
	seen: ReadonlySet<string>;
}

/**
 * Draws one agent the user has not seen yet. `random` returns a float in [0, 1)
 * and is injectable so tests are deterministic. Returns null only for an empty
 * pool.
 */
export function drawMysteryAgent(
	pool: readonly MysteryAgent[],
	seen: ReadonlySet<string>,
	random: () => number = Math.random
): MysteryDraw | null {
	if (pool.length === 0) {
		return null;
	}
	let unseen = pool.filter((agent) => !seen.has(mysteryAgentId(agent)));
	let nextSeen = new Set(seen);
	if (unseen.length === 0) {
		// Deck exhausted: reshuffle everything back in.
		unseen = [...pool];
		nextSeen = new Set();
	}
	const index = Math.min(
		Math.floor(random() * unseen.length),
		unseen.length - 1
	);
	const agent = unseen[index];
	if (!agent) {
		return null;
	}
	nextSeen.add(mysteryAgentId(agent));
	return { agent, seen: nextSeen };
}

/** The card fields a template's rarity is earned from. */
export type MysteryTemplateSignals = Pick<
	MarketplaceCard,
	| "firstParty"
	| "orgVerified"
	| "ratingAverage"
	| "ratingCount"
	| "verification"
>;

export function mysteryRarity(agent: MysteryAgent): MysteryRarity {
	return agent.kind === "runtime"
		? runtimeRarity(agent.entry)
		: templateRarity(agent.card);
}

export function runtimeRarity(entry: AgentCatalogEntry): MysteryRarity {
	if (entry.recommended) {
		return "legendary";
	}
	if (entry.detected === true) {
		return "epic";
	}
	return entry.registryId ? "rare" : "common";
}

export function templateRarity(card: MysteryTemplateSignals): MysteryRarity {
	if (card.firstParty || card.orgVerified) {
		return "legendary";
	}
	if (card.ratingCount >= MIN_RATINGS_FOR_TIER && card.ratingAverage >= 4.5) {
		return "epic";
	}
	if (
		card.verification === "verified" ||
		card.ratingCount >= MIN_RATINGS_FOR_TIER
	) {
		return "rare";
	}
	return "common";
}

/** Why this card got its tier, shown under the rarity chip. */
export function mysteryRarityReason(agent: MysteryAgent): string | null {
	if (agent.kind === "runtime") {
		const { entry } = agent;
		if (entry.recommended) {
			return "Recommended by Ryu";
		}
		if (entry.detected === true) {
			return "Already on this machine";
		}
		return entry.registryId ? "From the agent registry" : null;
	}
	return templateRarityReason(agent.card);
}

export function templateRarityReason(
	card: MysteryTemplateSignals
): string | null {
	if (card.firstParty) {
		return "Published by Ryu";
	}
	if (card.orgVerified) {
		return "Verified publisher";
	}
	if (card.ratingCount >= MIN_RATINGS_FOR_TIER) {
		return `Rated ${card.ratingAverage.toFixed(1)} by ${card.ratingCount} people`;
	}
	return card.verification === "verified" ? "Signed template" : null;
}
