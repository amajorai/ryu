import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bannedCopyHits } from "../data/banned-copy.ts";
import { getProduct } from "../data/products.tsx";
import { getProductArchetype } from "./archetypes.ts";
import { productDocsPath } from "./product-docs-path.ts";
import { groundingErrors, repoRoot } from "./profile-grounding.ts";
import type { ProductProfile } from "./profile-types.ts";
import {
	getProductProfile,
	profileCopyStrings,
	profileGaps,
	profileShapeErrors,
} from "./profiles.ts";
import { PROFILES as BUILDER_A_PROFILES } from "./profiles-builder-a.ts";
import {
	ARCHETYPE,
	PROFILE_SLUGS,
	PROFILES,
	type ProfileSlug,
} from "./profiles-builder-b.ts";
import { WORKFLOWS_PROFILE } from "./profiles-builder-b-workflows.ts";

function profile(slug: ProfileSlug): ProductProfile {
	const found = PROFILES[slug];
	if (!found) {
		throw new Error(`no profile for ${slug}`);
	}
	return found;
}

/** Everything a visitor reads: profile copy, code samples and commands. */
function allCopy(entry: ProductProfile): string[] {
	return [
		...profileCopyStrings(entry),
		...(entry.code?.map((sample) => sample.code) ?? []),
		...(entry.quickstart?.flatMap((step) => step.command ?? []) ?? []),
	];
}

function codeSample(slug: ProfileSlug, id: string): string {
	const sample = profile(slug).code?.find((entry) => entry.id === id);
	if (!sample) {
		throw new Error(`no code sample ${id} on ${slug}`);
	}
	return sample.code;
}

function compareCategory(slug: string): string {
	const file = join(
		repoRoot(),
		"apps/web/src/data/comparisons",
		`${slug}.json`
	);
	return (JSON.parse(readFileSync(file, "utf8")) as { category: string })
		.category;
}

const BUILDER_PROFILES: readonly ProductProfile[] = [
	...Object.values(BUILDER_A_PROFILES),
	...Object.values(PROFILES),
].filter((entry): entry is ProductProfile => entry !== undefined);

describe.each(PROFILE_SLUGS)("%s profile", (slug) => {
	const entry = profile(slug);

	test("is the builder archetype and is registered", () => {
		expect(ARCHETYPE).toBe("builder");
		expect(getProductArchetype(slug)).toBe("builder");
		expect(getProductProfile(slug)).toBe(entry);
	});

	test("meets every requirement of its page", () => {
		expect(profileGaps(slug)).toEqual([]);
		expect(profileShapeErrors(entry)).toEqual([]);
	});

	test("is grounded in real repo files and quotes", () => {
		expect(groundingErrors(entry)).toEqual([]);
	});

	test("uses no banned copy, even inside code and commands", () => {
		expect(bannedCopyHits(allCopy(entry))).toEqual([]);
	});

	test("states no price, since none is published for builder tools", () => {
		expect(allCopy(entry).filter((text) => /\$\s?\d/.test(text))).toEqual([]);
	});

	test("carries a full fact sheet, code, a quickstart and further reading", () => {
		expect(entry.facts.length).toBeGreaterThanOrEqual(6);
		expect(entry.code?.length).toBeGreaterThanOrEqual(2);
		expect(entry.quickstart?.length).toBeGreaterThanOrEqual(4);
		expect(entry.docs?.length).toBeGreaterThanOrEqual(4);
		expect(entry.related?.length).toBeGreaterThanOrEqual(3);
		const labels = entry.facts.map((fact) => fact.label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	test("links the docs page behind its Read the docs button, if it has one", () => {
		const product = getProduct(slug);
		const docsPath = product ? productDocsPath(product) : undefined;
		const paths = entry.docs?.map((link) => link.path) ?? [];
		if (slug === "extensions") {
			expect(docsPath).toBe("/docs/extend/develop/extensions");
		} else {
			// Agents and Workflows have no docs button, so these links carry the page.
			expect(docsPath).toBeUndefined();
		}
		if (docsPath) {
			expect(paths).toContain(docsPath);
		}
	});

	test("every JSON sample parses", () => {
		for (const sample of entry.code ?? []) {
			if (sample.language === "json") {
				expect(() => JSON.parse(sample.code)).not.toThrow();
			}
		}
	});

	test("never installs a package that is not published", () => {
		const text = allCopy(entry).join("\n");
		expect(text).not.toMatch(/(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\s+@/);
		expect(text).not.toMatch(/pip install/);
		expect(text).not.toContain("@ryuhq/services");
	});
});

test("Workflows comes from its own file and is the one registered", () => {
	expect(PROFILES.workflows).toBe(WORKFLOWS_PROFILE);
});

test("each page opens on a different kind of code", () => {
	const languages = (slug: ProfileSlug) =>
		[...new Set(profile(slug).code?.map((sample) => sample.language))].sort();
	expect(languages("extensions")).toEqual(["bash", "json"]);
	expect(languages("agents")).toEqual(["bash", "json"]);
	expect(languages("workflows")).toEqual(["bash", "http", "json"]);

	const firstSamples = PROFILE_SLUGS.map((slug) => profile(slug).code?.[0]?.id);
	expect(firstSamples).toEqual([
		"extensions-manifest",
		"agents-cli",
		"workflows-fan-out",
	]);
	for (const slug of PROFILE_SLUGS) {
		for (const id of profile(slug).code?.map((sample) => sample.id) ?? []) {
			expect(id.startsWith(`${slug}-`)).toBe(true);
		}
	}
});

test("no two builder pages share a code id, a first step or a comparison", () => {
	const ids = BUILDER_PROFILES.flatMap((entry) => entry.code ?? []).map(
		(sample) => sample.id
	);
	expect(new Set(ids).size).toBe(ids.length);

	const firstSteps = BUILDER_PROFILES.map(
		(entry) => entry.quickstart?.[0]?.title
	);
	expect(new Set(firstSteps).size).toBe(BUILDER_PROFILES.length);

	const compared = BUILDER_PROFILES.flatMap(
		(entry) => entry.compareSlugs ?? []
	);
	expect(new Set(compared).size).toBe(compared.length);
});

test("the extension manifest grants every tool its agent uses", () => {
	const manifest = JSON.parse(
		codeSample("extensions", "extensions-manifest")
	) as {
		id: string;
		permission_grants: string[];
		runnables: { kind: string; config?: { tools?: string[] } }[];
		version: string;
	};
	expect(manifest.id).toMatch(/^@[a-z0-9-]+\/[a-z0-9-]+$/);
	expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
	const agentTools = manifest.runnables
		.filter((entry) => entry.kind === "agent")
		.flatMap((entry) => entry.config?.tools ?? []);
	expect(agentTools.length).toBeGreaterThan(0);
	for (const tool of agentTools) {
		expect(manifest.permission_grants).toContain(`mcp:${tool}`);
	}
	const install = codeSample("extensions", "extensions-install");
	expect(install).toContain(`/api/plugins/${manifest.id}/enable`);
	expect(install).not.toMatch(/Bearer [A-Za-z0-9]{12,}/);
});

test("tool filters use only a trailing wildcard on fully qualified ids", () => {
	const filters = JSON.parse(
		codeSample("extensions", "extensions-tool-filters")
	) as { contributes: { tool_filters: { tool: string }[] } };
	for (const { tool } of filters.contributes.tool_filters) {
		expect(tool).toMatch(/^[a-z0-9_-]+\.(?:[a-z0-9_-]+|\*)$/);
	}
});

test("the extension install step says it is newer than the npm release", () => {
	const install = profile("extensions").quickstart?.find((step) =>
		step.command?.startsWith("bunx ryu install")
	);
	expect(install?.description).toContain("newer than the 0.3.0 release");
});

test("the agent entry uses a real identity mode and never sets account access", () => {
	const entry = JSON.parse(codeSample("agents", "agents-app-entry")) as {
		kind: string;
		config: Record<string, unknown> & { identity_mode?: string };
	};
	expect(entry.kind).toBe("agent");
	expect(["managed", "individual", "mixed"]).toContain(
		entry.config.identity_mode ?? "missing"
	);
	expect(entry.config).not.toHaveProperty("account_access");
});

test("agent commands are all ryu-cli agents commands", () => {
	const lines = codeSample("agents", "agents-cli").split("\n");
	expect(lines.length).toBeGreaterThanOrEqual(3);
	for (const line of lines) {
		expect(line).toMatch(/^ryu-cli agents /);
	}
});

test("the agents quickstart walks from Trial to Active, never skipping Trial", () => {
	const titles = profile("agents").quickstart?.map((step) => step.title) ?? [];
	const trial = titles.findIndex((title) => title.includes("Trial"));
	const active = titles.findIndex((title) => title.includes("Active"));
	expect(trial).toBeGreaterThan(-1);
	expect(active).toBe(trial + 1);
});

test("workflow samples stay inside the documented limits", () => {
	const fanOut = JSON.parse(codeSample("workflows", "workflows-fan-out")) as {
		type: string;
		max_concurrency: number;
		branches: { id: string }[];
	};
	expect(fanOut.type).toBe("parallel");
	expect(fanOut.max_concurrency).toBeGreaterThanOrEqual(1);
	expect(fanOut.max_concurrency).toBeLessThanOrEqual(16);
	const branchIds = fanOut.branches.map((branch) => branch.id);
	expect(new Set(branchIds).size).toBe(branchIds.length);

	const schedule = JSON.parse(
		codeSample("workflows", "workflows-schedule")
	) as {
		triggers: { type: string; cron?: string; require_approval?: boolean }[];
	};
	expect(schedule.triggers[0]).toMatchObject({
		type: "schedule",
		require_approval: true,
	});
	expect(schedule.triggers[0]?.cron?.split(" ")).toHaveLength(5);

	expect(codeSample("workflows", "workflows-dry-run")).toStartWith(
		"POST /workflows/:id/run"
	);
	expect(codeSample("workflows", "workflows-fork")).toContain("/fork");
	const history = profile("workflows").quickstart?.find(
		(step) => step.command !== undefined
	);
	expect(history?.command).toEndWith("/history");
	expect(history?.command).not.toContain("-X POST");
});

test("comparisons sit in the right category for each page", () => {
	const categories = (slug: ProfileSlug) =>
		new Set((profile(slug).compareSlugs ?? []).map(compareCategory));
	expect([...categories("agents")]).toEqual(["Agent Builders & Automation"]);
	expect([...categories("workflows")]).toEqual(["Agent Builders & Automation"]);
	expect(profile("extensions").compareSlugs).toBeUndefined();
});
