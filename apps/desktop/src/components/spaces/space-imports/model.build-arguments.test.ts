import { afterEach, describe, expect, it } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n";
import type { ComposioAction } from "@/src/lib/api/composio.ts";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../../packages/i18n/src/active-locale.ts";
import { buildArguments } from "./model.ts";

const NOT_A_NUMBER = "{field} must be a number.";

const german = {
	direction: "ltr" as const,
	locale: "de",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		const table: Record<string, string> = {
			[NOT_A_NUMBER]: "{field} muss eine Zahl sein.",
		};
		const source = fallback ?? id;
		return formatMessage(table[source] ?? source, values, "de");
	},
};

const action: ComposioAction = {
	description: null,
	displayName: "List issues",
	inputSchema: {
		properties: {
			limit: { title: "Limit", type: "integer" },
			page_size: { type: "number" },
		},
	},
	name: "LIST_ISSUES",
	noAuth: false,
	tags: [],
	toolkit: "github",
};

describe("buildArguments", () => {
	afterEach(() => unregisterActiveI18nRuntime(german));

	it("parses numeric fields", () => {
		expect(buildArguments(action, { limit: "5", page_size: "2.5" })).toEqual({
			limit: 5,
			page_size: 2.5,
		});
	});

	it("names the field in English when the value is not a number", () => {
		expect(() => buildArguments(action, { limit: "many" })).toThrow(
			"Limit must be a number."
		);
		expect(() => buildArguments(action, { page_size: "x" })).toThrow(
			"page_size must be a number."
		);
	});

	it("translates the whole sentence in the UI language", () => {
		registerActiveI18nRuntime(german);
		expect(() => buildArguments(action, { limit: "viele" })).toThrow(
			"Limit muss eine Zahl sein."
		);
	});
});
