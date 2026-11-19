import { describe, expect, test } from "bun:test";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { localizedTextOf } from "../cli/localizedText.ts";
import { createErrorText } from "../i18n/error-text.ts";
import { createCliTranslator } from "../i18n/translate.ts";
import { fetchFeatureList } from "./featureList.ts";

describe("feature list refusals", () => {
	test("read as one catalogued sentence in the CLI locale", async () => {
		const target: ApiTarget = {
			url: "http://node.test",
			token: "t",
			fetch: () => Promise.resolve(new Response(null, { status: 403 })),
		};
		const error = (await fetchFeatureList(target, {
			idKeys: ["id"],
			path: "/api/models",
			titleKeys: ["name"],
		}).catch((caught: unknown) => caught as Error)) as Error;
		expect(error.message).toBe("/api/models failed: 403");
		expect(localizedTextOf(error)?.source).toBe("{path} failed: {status}");
		const german = createCliTranslator("de", {
			"{path} failed: {status}": "{path} fehlgeschlagen: {status}",
		});
		expect(createErrorText(german.trMessage)(error)).toBe(
			"/api/models fehlgeschlagen: 403"
		);
	});
});
