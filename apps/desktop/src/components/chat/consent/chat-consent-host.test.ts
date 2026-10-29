import { describe, expect, test } from "bun:test";
import type { CatalogEntry } from "@/src/lib/api/plugins.ts";
import { candidateFromEntry } from "./chat-consent-host.ts";

function entry(
	overrides: Partial<CatalogEntry> & { id: string }
): CatalogEntry {
	return {
		description: "",
		kinds: ["plugin"],
		name: overrides.id,
		tags: [],
		version: "1.0.0",
		...overrides,
	} as CatalogEntry;
}

const none = new Set<string>();
const notInstalled = new Map<string, { enabled: boolean }>();

describe("chat consent catalog mapping", () => {
	test("built-in and first-party listings are official and installable", () => {
		const candidate = candidateFromEntry(
			entry({
				author: "Ryu",
				downloads: 1200,
				id: "@ryu/mail",
				origin: "first_party",
				rating_average: 4.7,
				rating_count: 31,
			}),
			new Map([["@ryu/mail", { enabled: true }]]),
			new Set(["@ryu/mail"])
		);
		expect(candidate).toMatchObject({
			author: "Ryu",
			downloads: 1200,
			enabled: true,
			installable: true,
			installed: true,
			ratingAverage: 4.7,
			ratingCount: 31,
			requested: true,
			tier: "official",
		});
	});

	test("an identity-verified publisher is verified", () => {
		expect(
			candidateFromEntry(
				entry({ id: "acme", publisher_trust: "blue" }),
				notInstalled,
				none
			).tier
		).toBe("verified");
	});

	test("community listings are browse-only with an https review link", () => {
		const candidate = candidateFromEntry(
			entry({
				id: "gh:someone/linear-mcp",
				org_verified: true,
				origin: "community",
				repo_url: "https://github.com/someone/linear-mcp",
				reviewed: false,
				stars: 420,
			}),
			notInstalled,
			none
		);
		expect(candidate).toMatchObject({
			installable: false,
			reviewUrl: "https://github.com/someone/linear-mcp",
			reviewed: false,
			stars: 420,
			tier: "community",
		});
	});

	test("only the active marketplace's listings install from chat", () => {
		const fromActive = candidateFromEntry(
			entry({ catalog_source_id: "ryu-catalog", id: "acme" }),
			notInstalled,
			none,
			"ryu-catalog"
		);
		expect(fromActive).toMatchObject({ installable: true, storeOnly: false });
		const fromOther = candidateFromEntry(
			entry({ catalog_source_id: "integrations-sh", id: "acme" }),
			notInstalled,
			none,
			"ryu-catalog"
		);
		expect(fromOther).toMatchObject({ installable: false, storeOnly: true });
		// A single-source view stamps no source: the install resolves the same one.
		expect(
			candidateFromEntry(
				entry({ id: "acme" }),
				notInstalled,
				none,
				"ryu-catalog"
			).installable
		).toBe(true);
	});

	test("a self-claimed @ryu id does not make a listing official", () => {
		expect(
			candidateFromEntry(
				entry({ id: "@ryu/totally-official" }),
				notInstalled,
				none
			).tier
		).toBe("community");
	});

	test("non-https review links are dropped", () => {
		expect(
			candidateFromEntry(
				entry({
					homepage: "javascript:alert(1)",
					id: "x",
					origin: "community",
				}),
				notInstalled,
				none
			).reviewUrl
		).toBeNull();
	});
});
