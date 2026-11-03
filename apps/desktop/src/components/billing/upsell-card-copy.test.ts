import { describe, expect, it } from "bun:test";
import type { UpsellCard } from "@ryu/auth/lib/upsell";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import { upsellCardCopy } from "./upsell-card-copy.ts";

const germanNumbers: LiteralMessage = (source, values) =>
	formatMessage(source, values, "de");

const card = (overrides: Partial<UpsellCard>): UpsellCard => ({
	headline: "English fallback",
	id: "investment-conversations",
	lever: "investment",
	metric: "conversations",
	subtext: "English subtext",
	value: 1200,
	...overrides,
});

describe("upsellCardCopy", () => {
	it("builds the investment sentence from the value in the active locale", () => {
		const copy = upsellCardCopy(card({}), germanNumbers);
		expect(copy.headline).toBe("You've started 1.200 conversations");
		expect(copy.subtext).toBe(
			"All that context lives in Ryu — keep it working for you."
		);
	});

	it("uses the singular plural branch", () => {
		const copy = upsellCardCopy(
			card({ id: "investment-agent-time", metric: "agent-time", value: 1 }),
			germanNumbers
		);
		expect(copy.headline).toBe("Your agents have worked 1 hour for you");
	});

	it("falls back to the server copy for dormant levers", () => {
		const copy = upsellCardCopy(
			card({ id: "friction-maxOpenTabs", lever: "friction", metric: "x" }),
			germanNumbers
		);
		expect(copy).toEqual({
			headline: "English fallback",
			subtext: "English subtext",
		});
	});
});
