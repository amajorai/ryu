// apps/desktop/src/lib/agent-mystery-box.test.ts
//
// The Mystery Box's promises: it only ever contains agents the user could still
// add, it never repeats a pull until the deck is exhausted, and every rarity tier
// is earned from a real catalog signal.

import { describe, expect, it } from "bun:test";
import type { AgentCatalogEntry } from "@/src/lib/api/agents.ts";
import {
	buildMysteryPool,
	drawMysteryAgent,
	MYSTERY_BOX_FLAGSHIP_ID,
	type MysteryAgent,
	type MysteryTemplateSignals,
	mysteryAgentId,
	runtimeRarity,
	templateRarity,
	templateRarityReason,
} from "./agent-mystery-box.ts";

function entry(over: Partial<AgentCatalogEntry> = {}): AgentCatalogEntry {
	return {
		added: false,
		available: true,
		bridgeVersionStatus: null,
		description: null,
		detected: null,
		engine: null,
		gatewayBypass: false,
		iconUrl: null,
		id: "acp:example",
		installedBridgeVersion: null,
		installedVersion: null,
		installHint: null,
		latestBridgeVersion: null,
		latestVersion: null,
		name: "Example",
		recommended: false,
		registryId: null,
		transport: "acp",
		versionStatus: null,
		...over,
	};
}

function signals(
	over: Partial<MysteryTemplateSignals> = {}
): MysteryTemplateSignals {
	return {
		firstParty: false,
		orgVerified: false,
		ratingAverage: 0,
		ratingCount: 0,
		verification: "unsigned",
		...over,
	};
}

function runtimePool(ids: string[]): MysteryAgent[] {
	return buildMysteryPool(
		ids.map((id) => entry({ id, name: id })),
		[]
	);
}

describe("buildMysteryPool", () => {
	it("holds only runtimes the user could still add", () => {
		const pool = buildMysteryPool(
			[
				entry({ id: MYSTERY_BOX_FLAGSHIP_ID, added: true }),
				entry({ id: "added", added: true }),
				entry({ id: "unavailable", available: false }),
				entry({ id: "open" }),
			],
			[]
		);
		expect(pool.map(mysteryAgentId)).toEqual(["runtime:open"]);
	});

	it("never offers the flagship, even if its row is not marked added", () => {
		const pool = buildMysteryPool([entry({ id: MYSTERY_BOX_FLAGSHIP_ID })], []);
		expect(pool).toEqual([]);
	});
});

describe("drawMysteryAgent", () => {
	it("returns null for an empty pool", () => {
		expect(drawMysteryAgent([], new Set())).toBeNull();
	});

	it("does not repeat a pull until every agent has come out", () => {
		const pool = runtimePool(["a", "b", "c"]);
		let seen: ReadonlySet<string> = new Set();
		const pulled: string[] = [];
		for (let i = 0; i < 3; i++) {
			const draw = drawMysteryAgent(pool, seen, () => 0);
			if (!draw) {
				throw new Error("expected a draw");
			}
			seen = draw.seen;
			pulled.push(mysteryAgentId(draw.agent));
		}
		expect(new Set(pulled).size).toBe(3);
	});

	it("reshuffles once the deck is exhausted", () => {
		const pool = runtimePool(["a", "b"]);
		const seen = new Set(pool.map(mysteryAgentId));
		const draw = drawMysteryAgent(pool, seen, () => 0.99);
		expect(draw && mysteryAgentId(draw.agent)).toBe("runtime:b");
		expect(draw?.seen.size).toBe(1);
	});

	it("stays in range when random returns its upper edge", () => {
		const pool = runtimePool(["a", "b"]);
		const draw = drawMysteryAgent(pool, new Set(), () => 1);
		expect(draw && mysteryAgentId(draw.agent)).toBe("runtime:b");
	});
});

describe("rarity", () => {
	it("ranks runtimes by real catalog signals", () => {
		expect(runtimeRarity(entry({ recommended: true }))).toBe("legendary");
		expect(runtimeRarity(entry({ detected: true }))).toBe("epic");
		expect(runtimeRarity(entry({ registryId: "codex-acp" }))).toBe("rare");
		expect(runtimeRarity(entry())).toBe("common");
	});

	it("ranks templates by publisher and community rating", () => {
		expect(templateRarity(signals({ firstParty: true }))).toBe("legendary");
		expect(templateRarity(signals({ orgVerified: true }))).toBe("legendary");
		expect(
			templateRarity(signals({ ratingAverage: 4.8, ratingCount: 12 }))
		).toBe("epic");
		expect(templateRarity(signals({ verification: "verified" }))).toBe("rare");
		expect(templateRarity(signals())).toBe("common");
	});

	it("does not let a handful of ratings earn a top tier", () => {
		expect(templateRarity(signals({ ratingAverage: 5, ratingCount: 1 }))).toBe(
			"common"
		);
		expect(
			templateRarityReason(signals({ ratingAverage: 5, ratingCount: 1 }))
		).toBeNull();
	});

	it("explains a rating tier with the real numbers", () => {
		expect(
			templateRarityReason(signals({ ratingAverage: 4.75, ratingCount: 8 }))
		).toBe("Rated 4.8 by 8 people");
	});
});
