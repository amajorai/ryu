import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	RailAccount,
	UsageRailSource,
} from "@/src/lib/usage-rail/usage-rail-sources.ts";
import { UsageRailCard } from "./usage-rail-card.tsx";

// The card of a ring lists every account of the source. Each window reads as
// one whole sentence, and a used-up account is marked in words, so colour is
// never the only signal.

const FIVE_HOURS = 5 * 3600;
const WEEK = 7 * 24 * 3600;
const RESET = "2026-11-26T09:30:00.000Z";

function account(
	id: string,
	sessionUsed: number,
	weeklyUsed: number,
	active = false
): RailAccount {
	const limited = sessionUsed >= 100 || weeklyUsed >= 100;
	return {
		active,
		id,
		label: `${id}@example.test`,
		leftPercent: 100 - Math.max(sessionUsed, weeklyUsed),
		limited,
		limitedUntil: limited ? RESET : null,
		state: "ok",
		windows: [
			{
				key: `5h-${id}`,
				label: "5h",
				model: null,
				resetsAt: RESET,
				usedPercent: sessionUsed,
				windowSeconds: FIVE_HOURS,
			},
			{
				key: `7d-${id}`,
				label: "7d",
				model: null,
				resetsAt: RESET,
				usedPercent: weeklyUsed,
				windowSeconds: WEEK,
			},
		],
	};
}

function pool(accounts: RailAccount[]): UsageRailSource {
	const readable = accounts.filter((entry) => entry.leftPercent !== null);
	const left =
		readable.reduce((sum, entry) => sum + (entry.leftPercent ?? 0), 0) /
		Math.max(1, readable.length);
	return {
		accounts,
		id: "pool:work",
		kind: "pool",
		leftPercent: left,
		logo: { kind: "initial", text: "W" },
		name: "Work pool",
		readable: readable.length,
		tracks: [{ label: null, usedPercent: 100 - left }],
	};
}

describe("the card of a usage ring", () => {
	test("lists every account with each window as one sentence", () => {
		const html = renderToStaticMarkup(
			<UsageRailCard
				mode="remaining"
				sources={[
					pool([account("day", 40, 75, true), account("night", 10, 20)]),
				]}
			/>
		);
		expect(html).toContain("Work pool");
		expect(html).toContain("Account pool");
		expect(html).toContain("day@example.test");
		expect(html).toContain("night@example.test");
		expect(html).toContain("5h: 60% left");
		expect(html).toContain("7d: 25% left");
		expect(html).toContain("5h: 90% left");
		expect(html.match(/data-testid="usage-rail-account"/g)?.length).toBe(2);
		// No account is limited, so none is marked.
		expect(html).not.toContain("data-limited");
		expect(html).not.toContain("Limited");
	});

	test("reads as used when the preference says so", () => {
		const html = renderToStaticMarkup(
			<UsageRailCard mode="used" sources={[pool([account("day", 40, 75)])]} />
		);
		expect(html).toContain("5h: 40% used");
		expect(html).toContain("7d: 75% used");
		expect(html).not.toContain("% left");
	});

	test("marks a used-up account in words, with the reset time", () => {
		const html = renderToStaticMarkup(
			<UsageRailCard
				mode="remaining"
				sources={[pool([account("day", 100, 60), account("night", 10, 20)])]}
			/>
		);
		expect(html.match(/data-limited=""/g)?.length).toBe(1);
		expect(html).toContain("Limited until ");
		expect(html).toContain("5h: 0% left");
	});

	test("says why an account has no number", () => {
		const signedOut: RailAccount = {
			active: false,
			id: "old",
			label: "old@example.test",
			leftPercent: null,
			limited: false,
			limitedUntil: null,
			state: "needs_reauth",
			windows: [],
		};
		const html = renderToStaticMarkup(
			<UsageRailCard
				mode="remaining"
				sources={[pool([account("day", 40, 75), signedOut])]}
			/>
		);
		expect(html).toContain("old@example.test");
		expect(html).toContain("needs a new sign-in");
	});

	test("the card of the +N ring has one section per source", () => {
		const second: UsageRailSource = {
			...pool([account("solo", 5, 5)]),
			id: "provider:claude",
			kind: "provider",
			name: "Claude Pro/Max",
		};
		const html = renderToStaticMarkup(
			<UsageRailCard
				mode="remaining"
				sources={[pool([account("day", 40, 75)]), second]}
			/>
		);
		expect(html.match(/<section/g)?.length).toBe(2);
		expect(html).toContain("Accounts outside every pool");
		expect(html).toContain("Select the ring to open the Usage page.");
	});
});
