import { describe, expect, test } from "bun:test";
import { isHiddenAtNoDetail } from "../tool-detail-visibility.ts";
import {
	type ConsentPluginCandidate,
	connectRequestFromInput,
	consentRequestKind,
	formatCompactCount,
	formatRating,
	pluginRequestFromInput,
	pluginTrustTier,
	rankPluginCandidates,
	reputationScore,
} from "./consent-tool.ts";

function candidate(
	overrides: Partial<ConsentPluginCandidate> & { id: string }
): ConsentPluginCandidate {
	return {
		author: null,
		description: null,
		downloads: null,
		enabled: false,
		iconUrl: null,
		installable: true,
		installed: false,
		name: overrides.id,
		ratingAverage: null,
		ratingCount: null,
		requested: false,
		reviewed: null,
		reviewUrl: null,
		stars: null,
		storeOnly: false,
		tier: "community",
		version: null,
		...overrides,
	};
}

describe("consent request parts", () => {
	test("recognises typed and dynamic parts", () => {
		expect(consentRequestKind("tool-consent.connect_app", undefined)).toBe(
			"connect_app"
		);
		expect(consentRequestKind("dynamic-tool", "consent.install_plugin")).toBe(
			"install_plugin"
		);
		expect(consentRequestKind("dynamic-tool", "ui.render")).toBeNull();
		expect(consentRequestKind("tool-Bash", undefined)).toBeNull();
	});

	test("consent cards stay visible when tool detail is hidden", () => {
		expect(
			isHiddenAtNoDetail({
				input: { app: "gmail", reason: "x" },
				state: "output-available",
				toolName: "consent.connect_app",
				type: "dynamic-tool",
			})
		).toBe(false);
		expect(
			isHiddenAtNoDetail({ state: "output-available", type: "tool-Read" })
		).toBe(true);
	});
});

describe("connect requests", () => {
	test("defaults to composio and trims fields", () => {
		expect(
			connectRequestFromInput({ app: " gmail ", reason: " Read mail " })
		).toEqual({
			app: "gmail",
			pluginId: null,
			provider: "composio",
			reason: "Read mail",
		});
	});

	test("mcp needs a plugin id; missing fields are rejected", () => {
		expect(
			connectRequestFromInput({ app: "linear", provider: "mcp", reason: "x" })
		).toBeNull();
		expect(
			connectRequestFromInput({
				app: "linear",
				pluginId: "@ryu/linear",
				provider: "mcp",
				reason: "x",
			})?.pluginId
		).toBe("@ryu/linear");
		expect(connectRequestFromInput({ app: "gmail" })).toBeNull();
		expect(connectRequestFromInput({ app: "", reason: "x" })).toBeNull();
		expect(connectRequestFromInput("gmail")).toBeNull();
	});

	test("counts characters the way Core does", () => {
		// 141 emoji: 141 Unicode scalars (Core's count), 282 UTF-16 units.
		const reason = "😀".repeat(141);
		expect(connectRequestFromInput({ app: "gmail", reason })?.reason).toBe(
			reason
		);
		expect(
			connectRequestFromInput({ app: "gmail", reason: "😀".repeat(281) })
		).toBeNull();
	});

	test("rejects exactly what Core rejects", () => {
		// Core caps `app` at 200 characters and refuses unknown providers.
		expect(
			connectRequestFromInput({ app: "a".repeat(201), reason: "x" })
		).toBeNull();
		expect(
			connectRequestFromInput({ app: "a".repeat(200), reason: "x" })
		).not.toBeNull();
		expect(
			connectRequestFromInput({
				app: "gmail",
				provider: "passwords",
				reason: "x",
			})
		).toBeNull();
		// Null and blank optionals are absent, as in Core.
		expect(
			connectRequestFromInput({
				app: "gmail",
				pluginId: null,
				provider: "",
				reason: "x",
			})?.provider
		).toBe("composio");
		// Snake-case spellings are not part of the contract.
		expect(
			connectRequestFromInput({
				app: "linear",
				plugin_id: "@ryu/linear",
				provider: "mcp",
				reason: "x",
			})
		).toBeNull();
	});
});

describe("install requests", () => {
	test("needs a query or ids and dedupes ids", () => {
		expect(pluginRequestFromInput({ reason: "x" })).toBeNull();
		expect(
			pluginRequestFromInput({
				pluginIds: ["@ryu/mail", "@ryu/mail", "acme"],
				reason: "x",
			})
		).toEqual({ pluginIds: ["@ryu/mail", "acme"], query: null, reason: "x" });
		expect(
			pluginRequestFromInput({
				pluginIds: ["a", "b", "c", "d", "e", "f"],
				reason: "x",
			})
		).toBeNull();
		expect(pluginRequestFromInput({ pluginIds: [""], reason: "x" })).toBeNull();
		expect(pluginRequestFromInput({ query: " linear ", reason: "x" })).toEqual({
			pluginIds: [],
			query: "linear",
			reason: "x",
		});
	});
});

describe("trust tiers", () => {
	test("official comes only from server-derived first-party signals", () => {
		expect(pluginTrustTier({ built_in: true })).toBe("official");
		expect(pluginTrustTier({ origin: "first_party" })).toBe("official");
		expect(pluginTrustTier({ publisher_trust: "gold" })).toBe("official");
	});

	test("verified needs an identity mark; community listings never verify", () => {
		expect(pluginTrustTier({ publisher_trust: "blue" })).toBe("verified");
		expect(pluginTrustTier({ org_verified: true })).toBe("verified");
		expect(pluginTrustTier({ org_verified: true, origin: "community" })).toBe(
			"community"
		);
		expect(pluginTrustTier({ publisher_trust: "dotted" })).toBe("community");
		expect(pluginTrustTier({})).toBe("community");
	});
});

describe("ranking", () => {
	test("orders official, verified, then community regardless of popularity", () => {
		const ranked = rankPluginCandidates([
			candidate({ downloads: 900_000, id: "popular-community", stars: 50_000 }),
			candidate({ id: "verified", tier: "verified" }),
			candidate({ id: "official", tier: "official" }),
		]);
		expect(ranked.map((c) => c.id)).toEqual([
			"official",
			"verified",
			"popular-community",
		]);
	});

	test("within a tier, named plugins come first, then reputation", () => {
		const ranked = rankPluginCandidates(
			[
				candidate({ downloads: 10, id: "few", tier: "verified" }),
				candidate({
					downloads: 50_000,
					id: "many",
					ratingAverage: 4.6,
					ratingCount: 120,
					tier: "verified",
				}),
				candidate({ id: "named", requested: true, tier: "verified" }),
			],
			5
		);
		expect(ranked.map((c) => c.id)).toEqual(["named", "many", "few"]);
	});

	test("one five-star review does not outrank a well-reviewed listing", () => {
		const lone = candidate({ id: "lone", ratingAverage: 5, ratingCount: 1 });
		const proven = candidate({
			id: "proven",
			ratingAverage: 4.5,
			ratingCount: 200,
		});
		expect(reputationScore(proven)).toBeGreaterThan(reputationScore(lone));
	});

	test("caps the list and keeps the first of duplicate ids", () => {
		const all = [
			candidate({ id: "a", name: "First" }),
			candidate({ id: "a", name: "Second" }),
			candidate({ id: "b" }),
			candidate({ id: "c" }),
			candidate({ id: "d" }),
		];
		expect(rankPluginCandidates(all)).toHaveLength(3);
		const everything = rankPluginCandidates(all, 10);
		expect(everything).toHaveLength(4);
		expect(everything.find((c) => c.id === "a")?.name).toBe("First");
	});
});

describe("formatting", () => {
	test("compact counts and ratings hide empty values", () => {
		expect(formatCompactCount(12_400)).toBe("12.4K");
		expect(formatCompactCount(0)).toBeNull();
		expect(formatCompactCount(null)).toBeNull();
		expect(formatRating(4.66, 12)).toBe("4.7");
		expect(formatRating(4.66, 0)).toBeNull();
		expect(formatRating(9, 3)).toBe("5.0");
	});
});
