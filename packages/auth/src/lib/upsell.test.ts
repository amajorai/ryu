import { describe, expect, it } from "bun:test";
import {
	selectUpsellCards,
	UPSELL_WEIGHTS,
	type UpsellCard,
	type UsageSnapshot,
} from "./upsell.ts";

// A fixed injected clock; the selector is time-independent in V1 but takes the
// clock for determinism parity with decideDesktopAccess.
const NOW = 1_000_000_000_000;

// A zeroed snapshot the fixtures extend, so each test states only what it means.
const EMPTY: UsageSnapshot = {
	sessionCount: 0,
	agentSeconds: 0,
	requestCount: 0,
	streakDays: 0,
};

const levers = (cards: UpsellCard[]): Set<string> =>
	new Set(cards.map((c) => c.lever));

describe("selectUpsellCards — weak usage yields few or no cards", () => {
	it("returns no cards for a brand-new user", () => {
		const cards = selectUpsellCards(EMPTY, UPSELL_WEIGHTS, NOW);
		expect(cards).toEqual([]);
	});

	it("returns no cards below the milestone threshold", () => {
		// Under 100 on every metric → no milestone crossed → score under minScore.
		const snapshot: UsageSnapshot = {
			...EMPTY,
			sessionCount: 40,
			agentSeconds: 90,
			requestCount: 25,
			streakDays: 2,
		};
		expect(selectUpsellCards(snapshot, UPSELL_WEIGHTS, NOW)).toEqual([]);
	});

	it("surfaces a card the moment the first milestone is crossed", () => {
		const below = selectUpsellCards(
			{ ...EMPTY, sessionCount: 99 },
			UPSELL_WEIGHTS,
			NOW
		);
		expect(below).toEqual([]);

		const at = selectUpsellCards(
			{ ...EMPTY, sessionCount: 100 },
			UPSELL_WEIGHTS,
			NOW
		);
		expect(at).toHaveLength(1);
		expect(at[0]?.metric).toBe("conversations");
	});
});

describe("selectUpsellCards — investment lever (V1)", () => {
	const heavy: UsageSnapshot = {
		...EMPTY,
		sessionCount: 1200,
		agentSeconds: 7200,
		requestCount: 800,
		streakDays: 30,
	};

	it("returns investment cards for a heavy user", () => {
		const cards = selectUpsellCards(heavy, UPSELL_WEIGHTS, NOW);
		expect(cards.length).toBeGreaterThanOrEqual(2);
		expect(cards.length).toBeLessThanOrEqual(UPSELL_WEIGHTS.maxCards);
		for (const c of cards) {
			expect(c.lever).toBe("investment");
		}
	});

	it("frames sessionCount as conversations (starts, not completions)", () => {
		const cards = selectUpsellCards(heavy, UPSELL_WEIGHTS, NOW);
		const convo = cards.find((c) => c.metric === "conversations");
		expect(convo).toBeDefined();
		expect(convo?.value).toBe(1200);
		expect(convo?.headline).toContain("conversations");
	});

	it("reports agent time as whole hours in the card value", () => {
		const cards = selectUpsellCards(heavy, UPSELL_WEIGHTS, NOW);
		const agent = cards.find((c) => c.metric === "agent-time");
		expect(agent?.value).toBe(2); // 7200s → 2h
	});

	it("never surfaces a '0 hours' agent-time card for sub-hour runtime", () => {
		// 500s crosses two second-milestones (scores high) but rounds to 0h — it
		// must NOT emit an agent-time card that reads "0 hours".
		const cards = selectUpsellCards(
			{ ...EMPTY, agentSeconds: 500 },
			UPSELL_WEIGHTS,
			NOW
		);
		expect(cards.some((c) => c.metric === "agent-time")).toBe(false);
	});

	it("ranks by score (agent time > conversations > requests here)", () => {
		const cards = selectUpsellCards(heavy, UPSELL_WEIGHTS, NOW);
		expect(cards.map((c) => c.metric)).toEqual([
			"agent-time",
			"conversations",
			"requests",
		]);
	});

	it("never returns more than maxCards", () => {
		const cards = selectUpsellCards(heavy, UPSELL_WEIGHTS, NOW);
		expect(cards.length).toBeLessThanOrEqual(UPSELL_WEIGHTS.maxCards);
	});

	it("is deterministic for identical inputs", () => {
		const a = selectUpsellCards(heavy, UPSELL_WEIGHTS, NOW);
		const b = selectUpsellCards(heavy, UPSELL_WEIGHTS, NOW + 5000);
		expect(a).toEqual(b);
	});
});

describe("selectUpsellCards — friction + desire stay silent until V2", () => {
	it("emits no friction/desire cards when the maps are empty", () => {
		const cards = selectUpsellCards(
			{ ...EMPTY, agentSeconds: 7200 },
			UPSELL_WEIGHTS,
			NOW
		);
		expect(levers(cards)).toEqual(new Set(["investment"]));
	});

	it("lights up friction + desire with zero selector change when maps arrive", () => {
		const snapshot: UsageSnapshot = {
			...EMPTY,
			agentSeconds: 7200, // investment: ~37.2
			capHits: { maxConcurrentRuns: 4 }, // friction: 32
			gatedAttempts: { "fine-tuning": 3 }, // desire: 36
		};
		const cards = selectUpsellCards(snapshot, UPSELL_WEIGHTS, NOW);
		expect(cards).toHaveLength(3);
		expect(levers(cards)).toEqual(
			new Set(["investment", "friction", "desire"])
		);
	});
});

describe("selectUpsellCards — lever diversity", () => {
	it("promotes a lower-scoring off-lever card over a third same-lever card", () => {
		// Three strong investment cards plus one weaker friction card. Pure score
		// would keep all three investment; diversity injects the friction card.
		const snapshot: UsageSnapshot = {
			...EMPTY,
			sessionCount: 1200,
			agentSeconds: 7200,
			requestCount: 1100,
			capHits: { maxAgents: 2 }, // friction: 16 (below the investment trio)
		};
		const cards = selectUpsellCards(snapshot, UPSELL_WEIGHTS, NOW);
		expect(cards).toHaveLength(3);
		expect(cards.some((c) => c.lever === "friction")).toBe(true);
	});
});

describe("selectUpsellCards — clock guard", () => {
	it("rejects a non-finite clock", () => {
		expect(() =>
			selectUpsellCards(EMPTY, UPSELL_WEIGHTS, Number.NaN)
		).toThrow();
	});
});
