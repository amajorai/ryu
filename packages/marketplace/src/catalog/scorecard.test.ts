// Unit tests for the store's automated trust scorecard. The properties that
// matter most are the ones a grade would quietly get wrong: `unknown` must never
// be scored as a failure, absence must only be punished where absence is itself
// meaningful, and an impersonating community listing must fail hard.

import { describe, expect, test } from "bun:test";
import { runScorecard, runSkillScorecard } from "./scorecard.ts";
import type {
	CatalogEntry,
	PluginCatalogDetail,
	SkillCard,
	SkillDetail,
} from "./types.ts";

/** A fixed clock so the maintenance checks are deterministic. */
const NOW = Date.parse("2026-07-24T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
	return {
		description: "A plugin that does a specific, clearly explained thing.",
		id: "com.example.thing",
		kinds: ["tool"],
		name: "Thing",
		tags: [],
		...overrides,
	};
}

/** A listing that passes essentially everything — the control for the tests that
 *  assert a single degraded signal moves the grade. */
function healthyDetail(
	overrides: Partial<PluginCatalogDetail> = {}
): PluginCatalogDetail {
	return {
		archived: false,
		description: "A plugin that does a specific, clearly explained thing.",
		engines: { ryu: ">=0.3.0" },
		issuesEnabled: true,
		license: "MIT",
		openIssues: 2,
		origin: "first-party",
		permissions: { declared: true, network: ["https://api.example.com"] },
		privacyPolicyUrl: "https://example.com/privacy",
		readme: "# Thing\n\n".concat("Real documentation. ".repeat(40)),
		repositoryUrl: "https://github.com/example/thing",
		reviewed: true,
		stars: 120,
		surfaces: ["desktop", "island"],
		termsOfServiceUrl: "https://example.com/terms",
		updatedAt: daysAgo(10),
		version: "1.4.2",
		versions: [
			{ publishedAt: daysAgo(10), version: "1.4.2" },
			{ publishedAt: daysAgo(120), version: "1.4.1" },
		],
		...overrides,
	};
}

function skillCard(overrides: Partial<SkillCard> = {}): SkillCard {
	return {
		id: "example/skills/review",
		installed: false,
		installs: 120,
		name: "Review skill",
		slug: "review",
		source: "github",
		trustLevel: "trusted",
		...overrides,
	};
}

function healthySkillDetail(overrides: Partial<SkillDetail> = {}): SkillDetail {
	return {
		card: skillCard(),
		description: "A reusable review workflow with a clear, bounded purpose.",
		files: [
			{
				contents: "# Review skill\n\n".concat(
					"Documented instructions. ".repeat(30)
				),
				path: "SKILL.md",
			},
		],
		metadata: {
			firstSeen: daysAgo(20),
			githubCreatedAt: daysAgo(300),
			githubPushedAt: daysAgo(10),
			githubStars: "40",
			githubUpdatedAt: daysAgo(10),
			installs: "120",
			repositoryUrl: "https://github.com/example/review-skill",
			securityAudits: [
				{
					name: "Registry audit",
					status: "pass",
					url: "https://example.com/audit",
				},
			],
		},
		readme: "# Review skill\n\n".concat("Real documentation. ".repeat(40)),
		url: "https://github.com/example/review-skill",
		...overrides,
	};
}

function statusOf(card: ReturnType<typeof runScorecard>, id: string) {
	return card.checks.find((c) => c.id === id)?.status;
}

describe("runScorecard", () => {
	test("a healthy first-party listing grades A", () => {
		const card = runScorecard(entry(), healthyDetail(), NOW);
		expect(card.score).not.toBeNull();
		expect(card.grade).toBe("A");
		expect(card.checks.some((c) => c.status === "fail")).toBe(false);
	});

	test("an unreviewed community listing is graded down but not zeroed", () => {
		const card = runScorecard(
			entry({ origin: "community", reviewed: false }),
			healthyDetail({ origin: "community", reviewed: false }),
			NOW
		);
		expect(statusOf(card, "reviewed")).toBe("fail");
		expect(statusOf(card, "provenance")).toBe("warn");
		expect(card.score).toBeLessThan(90);
		expect(card.score).toBeGreaterThan(0);
	});

	test("unknown checks are excluded from the score, not counted as failures", () => {
		// A detail with no timestamps and no version list: the two maintenance
		// checks report `unknown` and must not drag the grade down.
		const sparse = healthyDetail({ updatedAt: null, versions: null });
		const card = runScorecard(entry(), sparse, NOW);
		expect(statusOf(card, "activity")).toBe("unknown");
		expect(statusOf(card, "release-history")).toBe("unknown");
		expect(card.grade).toBe("A");
		expect(card.evaluated).toBeLessThan(card.checks.length);
	});

	test("scores over an empty listing rather than throwing", () => {
		const card = runScorecard(null, null, NOW);
		expect(card.checks.length).toBeGreaterThan(0);
		expect(card.summary).toBeTruthy();
	});

	test("a missing licence is a failure, because the terms are then undefined", () => {
		const card = runScorecard(
			entry({ license: null }),
			healthyDetail({ license: null }),
			NOW
		);
		expect(statusOf(card, "license")).toBe("fail");
	});

	test("a community listing claiming a reserved id fails the identity check", () => {
		const card = runScorecard(
			entry({ origin: "community" }),
			healthyDetail({ manifestId: "@ryu/mail", origin: "community" }),
			NOW
		);
		expect(statusOf(card, "identity")).toBe("fail");
	});

	test("a community listing under its own id passes the identity check", () => {
		const card = runScorecard(
			entry({ origin: "community" }),
			healthyDetail({ manifestId: "dev.someone.thing", origin: "community" }),
			NOW
		);
		expect(statusOf(card, "identity")).toBe("pass");
	});

	test("staleness escalates from pass to warn to fail", () => {
		const at = (days: number) =>
			statusOf(
				runScorecard(entry(), healthyDetail({ updatedAt: daysAgo(days) }), NOW),
				"activity"
			);
		expect(at(10)).toBe("pass");
		expect(at(200)).toBe("warn");
		expect(at(900)).toBe("fail");
	});

	test("an archived repository fails outright", () => {
		const card = runScorecard(entry(), healthyDetail({ archived: true }), NOW);
		expect(statusOf(card, "archived")).toBe("fail");
	});

	test("no privacy policy is worse when the plugin can reach the network", () => {
		const sandboxed = runScorecard(
			entry(),
			healthyDetail({
				permissions: { declared: true },
				permissionGrants: [],
				privacyPolicyUrl: null,
			}),
			NOW
		);
		expect(statusOf(sandboxed, "privacy-policy")).toBe("warn");

		const networked = runScorecard(
			entry(),
			healthyDetail({
				permissions: { declared: true, network: true },
				privacyPolicyUrl: null,
			}),
			NOW
		);
		expect(statusOf(networked, "privacy-policy")).toBe("fail");
	});

	test("unrestricted permissions warn; scoped permissions pass", () => {
		const broad = runScorecard(
			entry(),
			healthyDetail({ permissions: { declared: true, network: true } }),
			NOW
		);
		expect(statusOf(broad, "permission-breadth")).toBe("warn");

		const scoped = runScorecard(entry(), healthyDetail(), NOW);
		expect(statusOf(scoped, "permission-breadth")).toBe("pass");
	});

	test("declaring no runtime permissions is a pass, not a gap", () => {
		const card = runScorecard(
			entry(),
			healthyDetail({ permissions: undefined }),
			NOW
		);
		expect(statusOf(card, "permission-breadth")).toBe("pass");
	});

	test("keeps broad-permission scoring shallow across arbitrary manifest keys", () => {
		for (const fixture of [
			{ value: true, status: "warn" },
			{ value: JSON.parse('{"__proto__":true}'), status: "warn" },
			{ value: ["https://example.com", "*"], status: "warn" },
			{ value: { futurePermission: true }, status: "warn" },
			{ value: { futurePermission: "*" }, status: "warn" },
			{ value: { futurePermission: ["*"] }, status: "warn" },
			{ value: { futurePermission: { nested: true } }, status: "pass" },
			{ value: { futurePermission: false }, status: "pass" },
			{ value: [true], status: "pass" },
			{ value: "*", status: "pass" },
			{ value: null, status: "pass" },
		] as const) {
			const card = runScorecard(
				entry(),
				healthyDetail({
					permissions: { declared: true, network: fixture.value },
				}),
				NOW
			);
			expect(statusOf(card, "permission-breadth")).toBe(fixture.status);
		}
	});

	test("an unauthenticated sidecar route is flagged", () => {
		const card = runScorecard(
			entry(),
			healthyDetail({
				apiSurface: {
					sidecars: [
						{
							name: "api",
							routes: [
								{ auth: "user", path: "/status" },
								{ auth: "none", path: "/webhook" },
							],
						},
					],
				},
			}),
			NOW
		);
		expect(statusOf(card, "network-surface")).toBe("warn");
	});

	test("a dangling contribution id is reported as a manifest-integrity warning", () => {
		const card = runScorecard(
			entry(),
			healthyDetail({
				apiSurface: {
					commands: [
						{ id: "cmd.real", name: "Real" },
						{ id: "cmd.ghost", name: null },
					],
				},
			}),
			NOW
		);
		expect(statusOf(card, "manifest-integrity")).toBe("warn");
	});

	test("an enrichment error surfaces as a failed check with its message", () => {
		const card = runScorecard(
			entry(),
			healthyDetail({
				enrichmentError: "No plugin manifest found at the repository root.",
			}),
			NOW
		);
		const failed = card.checks.find((c) => c.id === "enrichment");
		expect(failed?.status).toBe("fail");
		expect(failed?.detail).toContain("No plugin manifest");
	});

	test("a non-semver version warns without failing the listing", () => {
		const card = runScorecard(
			entry(),
			healthyDetail({ version: "2026-07-24" }),
			NOW
		);
		expect(statusOf(card, "semver")).toBe("warn");
	});

	test("a v-prefixed and pre-release semver both pass", () => {
		for (const version of ["v1.0.0", "1.0.0-beta.2", "1.0.0+build.5"]) {
			const card = runScorecard(entry(), healthyDetail({ version }), NOW);
			expect(statusOf(card, "semver")).toBe("pass");
		}
	});

	test("a stub README warns and a missing one fails", () => {
		expect(
			statusOf(
				runScorecard(entry(), healthyDetail({ readme: "# Thing" }), NOW),
				"readme"
			)
		).toBe("warn");
		expect(
			statusOf(
				runScorecard(entry(), healthyDetail({ readme: null }), NOW),
				"readme"
			)
		).toBe("fail");
	});

	test("category rollups only include categories that produced checks", () => {
		const card = runScorecard(entry(), healthyDetail(), NOW);
		for (const category of card.categories) {
			expect(card.checks.some((c) => c.category === category.category)).toBe(
				true
			);
			const counted =
				category.pass + category.warn + category.fail + category.unknown;
			expect(counted).toBe(
				card.checks.filter((c) => c.category === category.category).length
			);
		}
	});

	test("the summary names the failures when there are any", () => {
		const card = runScorecard(
			entry({ origin: "community", reviewed: false }),
			healthyDetail({ license: null, origin: "community", reviewed: false }),
			NOW
		);
		expect(card.summary).toMatch(/failed check/);
	});

	test("the summary is clean when every check passes", () => {
		const card = runScorecard(entry(), healthyDetail(), NOW);
		expect(card.summary).toBe("Passes every automated check.");
	});

	test("skills use their own ruleset without plugin permission checks", () => {
		const card = runSkillScorecard(skillCard(), healthySkillDetail(), NOW);
		expect(card.rulesetVersion).toBe("marketplace-skill-1");
		expect(card.grade).toBe("A");
		expect(card.checks.some((check) => check.id === "permission-breadth")).toBe(
			false
		);
		expect(
			card.checks.find((check) => check.id === "security-audits")?.status
		).toBe("pass");
	});
});
