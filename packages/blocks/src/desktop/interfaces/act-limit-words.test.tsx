import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
// The provider registers its runtime here; this test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";

// The 3D set pieces read the DOM on import.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

const { lobbyLimitText } = await import("./lobby-acts.tsx");
const { chalkedLimit } = await import("./market-acts-props.tsx");
const { borderClosed, borderOpens } = await import(
	"./passport-acts-stations.tsx"
);
const { quizLimitText } = await import("./quiz-acts-props.tsx");
const { forkliftLimit } = await import("./warehouse-acts-props.tsx");

/** Japanese wording for the limit sentences, keyed by English source. */
const JA: Record<string, string> = {
	"Back {time}": "{time} に再開",
	"Border closed": "国境閉鎖中",
	"Border closed till {time}": "{time} まで国境閉鎖",
	"Closed for now": "ただいま休業中",
	Cooldown: "クールダウン中",
	"Cooldown, back {time}": "クールダウン中、{time} に復帰",
	"Opens {time}": "{time} に開く",
	"Parked for now": "ただいま駐車中",
	"Sitting out, back {time}": "休憩中、{time} に復帰",
	"back {time}": "{time} に再開",
	"cooldown, back {time}": "クールダウン中、{time} に復帰",
};

const runtime = {
	direction: "ltr" as const,
	locale: "ja",
	translate: (_id: string, values?: MessageValuesInput, fallback = "") =>
		formatMessage(JA[fallback] ?? fallback, values ?? {}, "ja"),
};

afterEach(() => unregisterActiveI18nRuntime(runtime));

function limitedAct(source: "estimate" | "usage"): InterfaceAgentAct {
	return {
		blockers: [{ at: null, kind: "rate-limited", source, title: "Limit hit" }],
	} as unknown as InterfaceAgentAct;
}

describe("game limit words", () => {
	test("render whole Japanese sentences for a reported limit", () => {
		registerActiveI18nRuntime(runtime);
		const known = limitedAct("usage");
		expect(lobbyLimitText(known, "15:10")).toBe("クールダウン中、15:10 に復帰");
		expect(lobbyLimitText(known, null)).toBe("クールダウン中");
		expect(chalkedLimit(known, "15:10")).toBe("15:10 に再開");
		expect(chalkedLimit(known, null)).toBe("ただいま休業中");
		expect(borderClosed(known, "15:10")).toBe("15:10 まで国境閉鎖");
		expect(borderClosed(known, null)).toBe("国境閉鎖中");
		expect(borderOpens(known, "15:10")).toBe("15:10 に開く");
		expect(quizLimitText(known, "15:10")).toBe("休憩中、15:10 に復帰");
		expect(forkliftLimit(known, null)).toBe("ただいま駐車中");
	});

	test("an estimated limit uses the lower-case sentence the kit prefixes", () => {
		registerActiveI18nRuntime(runtime);
		const likely = limitedAct("estimate");
		expect(lobbyLimitText(likely, "15:10")).toBe(
			"クールダウン中、15:10 に復帰"
		);
		expect(forkliftLimit(likely, "15:10")).toBe("15:10 に再開");
	});

	test("English keeps its capitalized and lower-case forms", () => {
		const known = limitedAct("usage");
		const likely = limitedAct("estimate");
		expect(chalkedLimit(likely, null)).toBe("closed for now");
		expect(borderOpens(known, null)).toBe("Closed");
		expect(borderOpens(likely, "9:00")).toBe("opens 9:00");
		expect(quizLimitText(likely, null)).toBe("sitting out");
		expect(forkliftLimit(known, "9:00")).toBe("Back 9:00");
	});
});
