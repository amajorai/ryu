import { afterEach, expect, test } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import { submitReport } from "./marketplace-reports.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("submits a report with explicit nulls for omitted fields", async () => {
	const sent: { body: unknown; url: string }[] = [];
	globalThis.fetch = createFetchFixture(originalFetch, (input, init) => {
		sent.push({ body: JSON.parse(String(init?.body)), url: String(input) });
		return Promise.resolve(Response.json({}));
	});
	const result = await submitReport({
		id: "@ryu/crm",
		kind: "plugin",
		reason: "spam",
	});
	expect(result).toEqual({ suggestIssuesUrl: null });
	expect(sent[0]?.url.endsWith("/api/marketplace/report")).toBe(true);
	expect(sent[0]?.body).toEqual({
		details: null,
		homepage: null,
		id: "@ryu/crm",
		installSource: null,
		itemName: null,
		kind: "plugin",
		reason: "spam",
		source: "unknown",
	});
});
