import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mcpTransportItems } from "./ToolsLibrary-transport-items.ts";

function shippedCatalog(locale: string): Record<string, string> {
	const path = fileURLToPath(
		new URL(
			`../../../../../packages/i18n/locales/${locale}.json`,
			import.meta.url
		)
	);
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

describe("mcpTransportItems", () => {
	test("labels every transport in English", () => {
		expect(mcpTransportItems((source) => source)).toEqual({
			stdio: "Local process (stdio)",
			"streamable-http": "Streamable HTTP",
			sse: "Legacy HTTP + SSE",
		});
	});

	test("labels come from the catalog, so German shows no raw wire value", () => {
		const de = shippedCatalog("de");
		const items = mcpTransportItems((source) => de[source] ?? source);
		expect(items.stdio).toBe(de["Local process (stdio)"] ?? "");
		expect(items.sse).toBe(de["Legacy HTTP + SSE"] ?? "");
		expect(items.stdio).not.toBe("stdio");
	});
});
