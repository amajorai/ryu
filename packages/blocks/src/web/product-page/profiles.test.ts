import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { STAGE_PRODUCT_SLUGS } from "../backgrounds/stage-routes.ts";
import { bannedCopyHits } from "../data/banned-copy.ts";
import { PRODUCT_ARCHETYPE_BY_SLUG } from "./archetypes.ts";
import type { ProductProfile } from "./profile-types.ts";
import {
	getProductProfile,
	PRODUCT_PROFILES,
	PROFILE_FILES,
	profileCopyStrings,
	profileGaps,
	profileGapsFor,
	profileShapeErrors,
} from "./profiles.ts";
import * as agentApiA from "./profiles-agent-api-a.ts";
import * as agentApiB from "./profiles-agent-api-b.ts";
import * as builderA from "./profiles-builder-a.ts";
import * as builderB from "./profiles-builder-b.ts";
import * as catalog from "./profiles-catalog.ts";
import * as infrastructureA from "./profiles-infrastructure-a.ts";
import * as infrastructureB from "./profiles-infrastructure-b.ts";
import * as preview from "./profiles-preview.ts";
import * as workspace from "./profiles-workspace.ts";

const SOURCE = { path: "apps/web/content/pages/about.mdx" };

const STUB_MODULES = [
	["profiles-infrastructure-a.ts", infrastructureA],
	["profiles-infrastructure-b.ts", infrastructureB],
	["profiles-agent-api-a.ts", agentApiA],
	["profiles-agent-api-b.ts", agentApiB],
	["profiles-builder-a.ts", builderA],
	["profiles-builder-b.ts", builderB],
	["profiles-workspace.ts", workspace],
	["profiles-catalog.ts", catalog],
	["profiles-preview.ts", preview],
] as const;

test("the profile files split every stage slug between them exactly once", () => {
	const owned = PROFILE_FILES.flatMap((file) => [...file.slugs]);
	expect([...owned].sort()).toEqual([...STAGE_PRODUCT_SLUGS].sort());
	expect(new Set(owned).size).toBe(owned.length);
	expect(PROFILE_FILES.map((file) => file.file)).toEqual(
		STUB_MODULES.map(([file]) => file)
	);
});

test("each profile file owns only slugs of its declared archetype", () => {
	for (const [file, module] of STUB_MODULES) {
		for (const slug of module.PROFILE_SLUGS) {
			expect([file, slug, PRODUCT_ARCHETYPE_BY_SLUG[slug]]).toEqual([
				file,
				slug,
				module.ARCHETYPE,
			]);
		}
		for (const key of Object.keys(module.PROFILES)) {
			expect([
				file,
				(module.PROFILE_SLUGS as readonly string[]).includes(key),
			]).toEqual([file, true]);
		}
		expect(existsSync(new URL(`./${file}`, import.meta.url))).toBe(true);
	}
	expect(infrastructureA.PROFILE_SLUGS).toEqual(["core", "gateway", "cloud"]);
	expect(infrastructureB.PROFILE_SLUGS).toEqual([
		"red-team",
		"agents-as-a-service",
	]);
	expect(preview.PROFILE_SLUGS).toContain("hire");
});

test("the merged registry holds exactly the entries the files define", () => {
	const defined = STUB_MODULES.flatMap(([, module]) =>
		Object.keys(module.PROFILES)
	).sort();
	expect(Object.keys(PRODUCT_PROFILES).sort()).toEqual(defined);
	for (const slug of defined) {
		expect(getProductProfile(slug)).toBeDefined();
	}
	expect(getProductProfile("not-a-product")).toBeUndefined();
});

test("a missing profile misses every requirement of its archetype", () => {
	expect(profileGapsFor("box", undefined)).toEqual([
		"facts",
		"code",
		"interfaces",
		"docs",
		"limits",
		"openapi",
	]);
	expect(profileGapsFor("devices", undefined)).toEqual(["facts", "status"]);
	expect(profileGapsFor("marketplace", undefined)).toEqual([
		"facts",
		"catalog",
	]);
	// Docs are required only where the product has a "Read the docs" CTA.
	expect(profileGapsFor("not-a-product", undefined)).toEqual([
		"facts",
		"architecture",
		"code-or-comparison",
		"docs",
	]);
});

test("gaps close as a profile fills in", () => {
	const facts = [
		{ label: "One", value: "1", source: SOURCE },
		{ label: "Two", value: "2", source: SOURCE },
	];
	const onlyFacts: ProductProfile = { facts };
	expect(profileGapsFor("devices", onlyFacts)).toEqual(["status"]);
	const oneStatus: ProductProfile = {
		facts,
		status: { today: [{ text: "A", source: SOURCE }], planned: [] },
	};
	expect(profileGapsFor("devices", oneStatus)).toEqual(["status"]);
	const fullStatus: ProductProfile = {
		facts,
		status: {
			today: [{ text: "A", source: SOURCE }],
			planned: [{ text: "B", source: SOURCE }],
		},
	};
	expect(profileGapsFor("devices", fullStatus)).toEqual([]);
	expect(profileGapsFor("devices", { facts: facts.slice(0, 1) })).toEqual([
		"facts",
		"status",
	]);
	const comparison: ProductProfile = {
		facts,
		architecture: {
			title: "Flow",
			nodes: [
				{ label: "A", detail: "a" },
				{ label: "B", detail: "b" },
				{ label: "C", detail: "c" },
			],
			source: SOURCE,
		},
		comparison: {
			title: "Options",
			columns: ["Self-hosted", "Managed"],
			rows: [{ label: "Cost", values: ["Free", "At cost"] }],
			source: SOURCE,
		},
		docs: [{ label: "Core", path: "/docs/core" }],
	};
	expect(profileGapsFor("core", comparison)).toEqual([]);
});

test("registered profiles report their real gaps", () => {
	for (const slug of STAGE_PRODUCT_SLUGS) {
		expect(profileGaps(slug)).toEqual(
			profileGapsFor(slug, getProductProfile(slug))
		);
	}
});

test("shape errors catch what the types cannot", () => {
	const bad: ProductProfile = {
		facts: [],
		architecture: {
			title: "Flow",
			nodes: [{ label: "A", detail: "a" }],
			source: SOURCE,
		},
		comparison: {
			title: "Options",
			columns: ["A", "B"],
			rows: [{ label: "Cost", values: ["1"] }],
			source: SOURCE,
		},
		code: [
			{
				id: "x",
				label: "X",
				language: "bash",
				code: "ryu",
				source: { ...SOURCE, quote: "Ryu" },
			},
			{
				id: "x",
				label: "Y",
				language: "bash",
				code: "ryu",
				source: { ...SOURCE, quote: "Ryu" },
			},
		],
		docs: [{ label: "Bad", path: "https://example.com" }],
		interfaces: [
			{
				kind: "SDK",
				name: "@ryuhq/services",
				summary: "TypeScript SDK",
				status: "not-published",
				source: SOURCE,
			},
		],
	};
	expect(profileShapeErrors(bad)).toEqual([
		"architecture has 1 nodes; use 3–6",
		'comparison row "Cost" has 1 values for 2 columns',
		"code sample ids repeat",
		'docs link "Bad" must be a /docs path',
		'interface "@ryuhq/services" is not published but has no note',
	]);
	expect(profileShapeErrors({ facts: [] })).toEqual([]);
});

test("profile copy is collected for the banned-word check", () => {
	const profile: ProductProfile = {
		facts: [{ label: "Runtime", value: "A sidecar process", source: SOURCE }],
		status: {
			today: [{ text: "Works on a workcell", source: SOURCE }],
			planned: [],
		},
	};
	const copy = profileCopyStrings(profile);
	expect(copy).toEqual(["Runtime", "A sidecar process", "Works on a workcell"]);
	expect(bannedCopyHits(copy).sort()).toEqual(["sidecar", "workcell"]);
});

test("terminal transcripts are part of the checked copy", () => {
	const profile: ProductProfile = {
		facts: [],
		guardrail: {
			title: "Refused",
			description: "A blocked call",
			lines: [
				{ kind: "command", text: "ryu-cli run" },
				{ kind: "denied", text: "403 from the sidecar" },
			],
			source: SOURCE,
		},
	};
	const copy = profileCopyStrings(profile);
	expect(copy).toContain("403 from the sidecar");
	expect(bannedCopyHits(copy)).toEqual(["sidecar"]);
});

test("every registered profile is well formed and free of banned copy", () => {
	for (const [slug, profile] of Object.entries(PRODUCT_PROFILES)) {
		if (!profile) {
			continue;
		}
		expect([slug, profileShapeErrors(profile)]).toEqual([slug, []]);
		expect([slug, bannedCopyHits(profileCopyStrings(profile))]).toEqual([
			slug,
			[],
		]);
	}
});
