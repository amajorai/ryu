import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n";
import { poolUpsellCopy } from "./pool-upsell-copy.ts";

describe("poolUpsellCopy", () => {
	test("the upgrade line is one translated sentence with the pool as a value", () => {
		const tl: LiteralMessage = (source, values) =>
			source ===
			"{pool} runs on Ryu's own capacity — included with a Ryu subscription, no API keys."
				? `${String((values as Record<string, unknown> | undefined)?.pool)}は Ryu 独自の容量で動作します`
				: source;
		expect(poolUpsellCopy({ label: "Ryu Frontier" }, tl)).toEqual({
			upgrade: "Ryu Frontierは Ryu 独自の容量で動作します",
			byoKey: null,
		});
	});
});
