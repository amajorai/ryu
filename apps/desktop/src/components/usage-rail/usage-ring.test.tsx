import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	buildUsageRailSources,
	type RailAgentUsage,
	type UsageRailSource,
} from "@/src/lib/usage-rail/usage-rail-sources.ts";
import {
	limitedText,
	moreRingLabel,
	ringLabel,
	shownPercent,
} from "./usage-rail-text.ts";
import { MoreUsageRing, UsageRing } from "./usage-ring.tsx";

// The accessible name of a ring says what its arcs show: the source, then each
// window's percent, so a screen reader user gets the numbers without the card.

/** English with the values filled in, plurals resolved the way ICU would. */
const tl: LiteralMessage = (source, values) => {
	const filled = new Map<string, unknown>(Object.entries(values ?? {}));
	return source
		.replaceAll(
			/\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g,
			(_, name: string, one: string, other: string) => {
				const count = Number(filled.get(name));
				return (count === 1 ? one : other).replaceAll("#", String(count));
			}
		)
		.replaceAll(/\{(\w+)\}/g, (_, name: string) => String(filled.get(name)));
};

const FIVE_HOURS = 5 * 3600;
const WEEK = 7 * 24 * 3600;

function agent(session: number, weekly: number): RailAgentUsage {
	return {
		avatarUrl: null,
		engine: "claude",
		id: "acp:claude",
		name: "Claude Code",
		snapshot: {
			accountId: null,
			agentId: "acp:claude",
			available: true,
			engine: "claude",
			extraUsageUsd: null,
			meters: [],
			plan: "Max",
			reason: null,
			retryAfterSeconds: null,
			windows: [
				{
					label: "Session",
					model: null,
					resetsAt: "2026-11-26T09:30:00.000Z",
					usedPercent: session,
					windowSeconds: FIVE_HOURS,
				},
				{
					label: "Weekly",
					model: null,
					resetsAt: "2026-11-30T00:00:00.000Z",
					usedPercent: weekly,
					windowSeconds: WEEK,
				},
			],
		},
	};
}

function agentSource(session: number, weekly: number): UsageRailSource {
	const [source] = buildUsageRailSources({
		agents: [agent(session, weekly)],
		pools: [],
		providers: [],
	});
	if (!source) {
		throw new Error("the agent reading gave no source");
	}
	return source;
}

/** A pool of `left.length` accounts, each with that much left in its tightest window. */
function poolSource(left: number[]): UsageRailSource {
	const accounts = left.map((percent, index) => ({
		active: index === 0,
		id: `account-${index}`,
		label: `account-${index}@example.test`,
		leftPercent: percent,
		limited: percent === 0,
		limitedUntil: percent === 0 ? "2026-11-26T09:30:00.000Z" : null,
		state: "ok" as const,
		windows: [
			{
				key: `5h-${index}`,
				label: "5h",
				model: null,
				resetsAt: "2026-11-26T09:30:00.000Z",
				usedPercent: 100 - percent,
				windowSeconds: FIVE_HOURS,
			},
		],
	}));
	const mean = left.reduce((sum, percent) => sum + percent, 0) / left.length;
	return {
		accounts,
		id: "pool:work",
		kind: "pool",
		leftPercent: mean,
		logo: { kind: "initial", text: "W" },
		name: "Work pool",
		readable: left.length,
		tracks: [{ label: null, usedPercent: 100 - mean }],
	};
}

describe("the accessible name of a usage ring", () => {
	test("one sign-in names the source and each window's percent left", () => {
		expect(ringLabel(agentSource(40, 75), "remaining", tl)).toBe(
			"Usage of Claude Code: 5h: 60% left and 7d: 25% left"
		);
	});

	test("the same ring reads as used when the preference says so", () => {
		expect(ringLabel(agentSource(40, 75), "used", tl)).toBe(
			"Usage of Claude Code: 5h: 40% used and 7d: 75% used"
		);
	});

	test("a pool names the mean, the number of accounts and the limited ones", () => {
		expect(ringLabel(poolSource([80, 40, 0]), "remaining", tl)).toBe(
			"Usage of Work pool: 40% left on average across 3 accounts and 1 account limited"
		);
	});

	test("a used-up sign-in says so in words", () => {
		const source = agentSource(100, 20);
		expect(ringLabel(source, "remaining", tl)).toBe(
			"Usage of Claude Code: 5h: 0% left, 7d: 80% left, and 1 account limited"
		);
		const [account] = source.accounts;
		expect(account?.limited).toBe(true);
		expect(limitedText({ limitedUntil: null }, tl)).toBe(
			"Limited, reset time unknown"
		);
		expect(
			limitedText({ limitedUntil: account?.limitedUntil ?? null }, tl)
		).toStartWith("Limited until ");
	});

	test("the +N ring says whether it holds every source or the rest", () => {
		expect(moreRingLabel(3, false, tl)).toBe("Usage of 3 more sources");
		expect(moreRingLabel(6, true, tl)).toBe("Usage of 6 sources");
	});

	test("a shown percent is clamped and rounded", () => {
		expect(shownPercent(40.4, "remaining")).toBe(60);
		expect(shownPercent(140, "used")).toBe(100);
		expect(shownPercent(-5, "remaining")).toBe(100);
	});
});

describe("the ring button", () => {
	const open = () => undefined;

	test("is a button named after its source, with one arc per window", () => {
		const html = renderToStaticMarkup(
			<UsageRing
				mode="remaining"
				onOpen={open}
				side="top"
				size="row"
				source={agentSource(40, 75)}
			/>
		);
		expect(html).toContain(
			'<button aria-label="Usage of Claude Code: 5h: 60% left and 7d: 25% left"'
		);
		expect(html).toContain('type="button"');
		// The outer arc is the longest window (7d, 25% left), the inner the shortest.
		const arcs = [...html.matchAll(/stroke-dasharray="(\d+) 100"/g)].map(
			(match) => match[1]
		);
		expect(arcs).toEqual(["25", "60"]);
		// The arcs are decoration: the name carries the numbers.
		expect(html).toContain('aria-hidden="true"');
	});

	test("a pool of several accounts draws one arc, the mean left", () => {
		const html = renderToStaticMarkup(
			<UsageRing
				mode="remaining"
				onOpen={open}
				side="inline-end"
				size="rail"
				source={poolSource([80, 40, 0])}
			/>
		);
		const arcs = [...html.matchAll(/stroke-dasharray="(\d+) 100"/g)].map(
			(match) => match[1]
		);
		expect(arcs).toEqual(["40"]);
	});

	test("a spent window draws no arc in remaining mode instead of a dot", () => {
		const html = renderToStaticMarkup(
			<UsageRing
				mode="remaining"
				onOpen={open}
				side="top"
				size="footer"
				source={poolSource([0, 0])}
			/>
		);
		expect(html).not.toContain("stroke-dasharray");
		expect(html).toContain("2 accounts limited");
	});

	test("the +N ring shows the number of sources behind it", () => {
		const html = renderToStaticMarkup(
			<MoreUsageRing
				holdsAll={false}
				mode="remaining"
				onOpen={open}
				side="top"
				size="row"
				sources={[agentSource(10, 10), poolSource([50, 50])]}
			/>
		);
		expect(html).toContain('aria-label="Usage of 2 more sources"');
		expect(html).toContain("+2");
	});
});
