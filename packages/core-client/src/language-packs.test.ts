import { afterEach, expect, test } from "bun:test";
import { languagePackArchive } from "@ryu/i18n/core";
import {
	fetchInstalledLanguagePacks,
	importLanguagePack,
} from "./language-packs.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("keeps valid installed packs and drops malformed records", async () => {
	globalThis.fetch = Object.assign(
		async () =>
			Response.json({
				packs: [
					{
						baseLocale: "en",
						direction: "ltr",
						enabled: true,
						id: "community/online",
						locale: "en",
						messages: { "common.install": "Yeet it in" },
						name: "Online",
						schemaVersion: 1,
						version: "1.0.0",
					},
					{ id: "../unsafe" },
				],
			}),
		{
			preconnect: (..._args: Parameters<typeof fetch.preconnect>) => undefined,
		}
	);

	const packs = await fetchInstalledLanguagePacks({
		token: null,
		url: "http://127.0.0.1:7980",
	});

	expect(packs).toHaveLength(1);
	expect(packs[0]).toMatchObject({
		enabled: true,
		id: "community/online",
	});
});

test("imports a portable archive through Core and validates the returned pack", async () => {
	const pack = {
		baseLocale: "en",
		direction: "ltr" as const,
		id: "community/imported",
		locale: "en",
		messages: { "common.search": "Find" },
		name: "Imported",
		schemaVersion: 1 as const,
		version: "1.0.0",
	};
	const archive = languagePackArchive(pack);
	let requestBody: { archive_base64?: string } | undefined;
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			expect(String(input)).toBe(
				"http://127.0.0.1:7980/api/language-packs/import"
			);
			requestBody = JSON.parse(String(init?.body)) as {
				archive_base64?: string;
			};
			return Response.json({ pack });
		},
		{
			preconnect: (..._args: Parameters<typeof fetch.preconnect>) => undefined,
		}
	);

	const imported = await importLanguagePack(
		{ token: "node-token", url: "http://127.0.0.1:7980" },
		archive
	);

	expect(imported).toEqual(pack);
	expect(requestBody?.archive_base64).toBeString();
	expect(requestBody?.archive_base64?.length).toBeGreaterThan(0);
});
