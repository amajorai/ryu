import { expect, it } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { comparisonSections } from "./pricing-comparison.ts";

const JA: Record<string, string> = {
	"{count, plural, one {# person} other {# people}}":
		"{count, plural, other {#人}}",
	"{min}–{max} seats": "{min}〜{max} 席",
};

const japaneseTl: LiteralMessage = (source, values) =>
	formatMessage(JA[source] ?? source, values, "ja");

const peopleRow = (tl?: LiteralMessage, audience = "individual" as const) =>
	comparisonSections({ audience }, tl, tl ? "ja" : "en")
		.flatMap((section) => section.rows)
		.find((row) => row.id === "people");

it("the People row is one message per cell in English", () => {
	const individual = peopleRow();
	expect(individual?.values.pro).toBe("1 person");
	const organization = comparisonSections({ audience: "business" })
		.flatMap((section) => section.rows)
		.find((row) => row.id === "people");
	expect(organization?.values.teams).toBe("5–50 seats");
});

it("the People row reads in the reader's language", () => {
	const row = peopleRow(japaneseTl);
	expect(row?.values.pro).toBe("1人");
	expect(row?.values.teams).toBe("5〜50 席");
	expect(JSON.stringify(row?.values)).not.toContain("person");
});
