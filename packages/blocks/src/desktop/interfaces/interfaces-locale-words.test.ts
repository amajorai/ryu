// Painted and announced interface words follow the UI language: the arcade
// marquee, the quiz "ANSWERING" tile, quiz header casing and the Ticker
// countdown read through the active runtime instead of fixed English.

import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { agentActs } from "@ryuhq/protocol/interfaces";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import { cabinetWords } from "./arcade-acts.tsx";
import {
	FIXTURE_CLOCK,
	FIXTURE_NOW,
	usefulStateFixture,
} from "./game-acts-fixture.ts";
import { headerLines } from "./quiz-studio-panel.tsx";
import { countdown } from "./ticker-model.ts";

const DE: Record<string, string> = {
	ANSWERING: "ANTWORTET",
	"INSERT COIN": "MÜNZE EINWERFEN",
	"PAUSED · {title}": "PAUSIERT · {title}",
	"TILT · {title}": "TILT · {title}",
};

function standIn(locale: string, messages: Record<string, string>) {
	return {
		direction: locale === "ar" ? ("rtl" as const) : ("ltr" as const),
		locale,
		translate(id: string, values?: MessageValuesInput, fallback?: string) {
			const source = fallback ?? id;
			return formatMessage(messages[source] ?? source, values, locale);
		},
	};
}

const registered: ReturnType<typeof standIn>[] = [];
function useLocale(locale: string, messages: Record<string, string> = {}) {
	const runtime = standIn(locale, messages);
	registered.push(runtime);
	registerActiveI18nRuntime(runtime);
}

afterEach(() => {
	for (const runtime of registered.splice(0)) {
		unregisterActiveI18nRuntime(runtime);
	}
});

const fixture = usefulStateFixture();
const acts = agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK);
function marquee(name: string): string | null | undefined {
	const act = [...acts.values()].find((entry) => entry.agentName === name);
	if (!act) {
		throw new Error(`no agent ${name}`);
	}
	return cabinetWords(act, fixture, FIXTURE_NOW, FIXTURE_CLOCK).marquee;
}

describe("interface words in the UI language", () => {
	test("English is unchanged without a provider", () => {
		expect(marquee("Fa")).toBe("INSERT COIN · 15:10");
		expect(marquee("Di")).toBe("TILT · Tests failed");
		expect(headerLines("istanbul")).toEqual(["ISTANBUL"]);
		const inFive = new Date(FIXTURE_NOW + 5 * 60_000).toISOString();
		expect(countdown(inFive, FIXTURE_NOW)).toBe("in 5m");
	});

	test("German translates the marquee head words", () => {
		useLocale("de", DE);
		expect(marquee("Fa")).toBe("MÜNZE EINWERFEN · 15:10");
		expect(marquee("Di")).toBe("TILT · Tests failed");
	});

	test("Turkish casing and Arabic countdowns follow the active locale", () => {
		useLocale("tr");
		expect(headerLines("istanbul")).toEqual(["İSTANBUL"]);
		useLocale("ar");
		const inTwoHours = new Date(FIXTURE_NOW + 2 * 3_600_000).toISOString();
		expect(countdown(inTwoHours, FIXTURE_NOW)).toBe(
			new Intl.RelativeTimeFormat("ar", {
				numeric: "always",
				style: "narrow",
			}).format(2, "hour")
		);
	});
});
