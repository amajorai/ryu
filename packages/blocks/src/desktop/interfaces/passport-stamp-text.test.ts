// The stamp is measured in stampTextRows, so an untitled thread's fallback
// must be localized before it is wrapped and cut. Measured as English, a
// German stamp printed "Unbenannt" over an English "conversation".
import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import { stampTextRows, stampTitleText } from "./passport-stamp-text.ts";

const GERMAN: Record<string, string> = {
	"Untitled conversation": "Unbenannte Unterhaltung",
};

const german: ActiveI18nRuntime = {
	direction: "ltr",
	locale: "de",
	translate: (id: string, values?: MessageValuesInput, fallback?: string) =>
		formatMessage(GERMAN[fallback ?? id] ?? fallback ?? id, values),
};

afterEach(() => {
	unregisterActiveI18nRuntime(german);
});

const titleText = (title: string, shape: "circle" | "triangle" = "circle") =>
	stampTextRows({
		date: "01 NOV 2026",
		latest: "LATEST 02 NOV",
		marking: null,
		shape,
		title,
	})
		.filter((row) => row.family === "sans")
		.map((row) => row.text);

describe("stamp title fallback", () => {
	test("English keeps the source fallback and real titles", () => {
		expect(stampTitleText("")).toBe("Untitled conversation");
		expect(stampTitleText("Untitled conversation")).toBe(
			"Untitled conversation"
		);
		expect(stampTitleText("  Launch plan ")).toBe("Launch plan");
	});

	test("an untitled thread under German wraps the German fallback", () => {
		registerActiveI18nRuntime(german);
		const lines = titleText("Untitled conversation");
		expect(lines.join(" ")).toBe("Unbenannte Unterhaltung");
		expect(lines.join(" ")).not.toMatch(/Untitled|conversation/);
		expect(titleText("")).toEqual(lines);
	});

	test("the one-line triangle cuts the German string, not the English", () => {
		registerActiveI18nRuntime(german);
		const [line] = titleText("Untitled conversation", "triangle");
		expect(line?.startsWith("Unbenannt")).toBe(true);
		expect(line).not.toMatch(/Untitled|conversation/);
	});

	test("a real title is printed as given under German", () => {
		registerActiveI18nRuntime(german);
		expect(titleText("Settings").join(" ")).toBe("Settings");
	});
});
