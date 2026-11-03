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
import {
	ARCHETYPE,
	PROFILE_SLUGS,
	PROFILES,
	type ProfileSlug,
} from "./profiles-builder-a.ts";
import { MCP_PROFILE } from "./profiles-builder-a-mcp.ts";
import { SKILLS_PROFILE } from "./profiles-builder-a-skills.ts";

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

function compareCategory(slug: string): string {
	const file = join(
		repoRoot(),
		"apps/web/src/data/comparisons",
		`${slug}.json`
	);
	return (JSON.parse(readFileSync(file, "utf8")) as { category: string })
		.category;
}

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

	test("opens on code and walks through at least three quickstart steps", () => {
		expect(entry.code?.length).toBeGreaterThanOrEqual(2);
		expect(entry.quickstart?.length).toBeGreaterThanOrEqual(3);
		expect(entry.facts.length).toBeGreaterThanOrEqual(5);
		expect(entry.related?.length).toBeGreaterThanOrEqual(3);
	});

	test("links the docs page behind its Read the docs button, if it has one", () => {
		const product = getProduct(slug);
		const docsPath = product ? productDocsPath(product) : undefined;
		const paths = entry.docs?.map((link) => link.path) ?? [];
		expect(paths.length).toBeGreaterThanOrEqual(3);
		if (docsPath) {
			expect(paths).toContain(docsPath);
		}
	});

	test("never installs a package that is not published", () => {
		const text = allCopy(entry).join("\n");
		expect(text).not.toMatch(/(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\s+@/);
		expect(text).not.toMatch(/pip install/);
		expect(text).not.toContain('from "@ryuhq/services"');
	});
});

test("MCP and Skills come from their own files and are the ones registered", () => {
	expect(PROFILES.mcp).toBe(MCP_PROFILE);
	expect(PROFILES.skills).toBe(SKILLS_PROFILE);
});

test("each page opens on a different kind of code", () => {
	const languages = (slug: ProfileSlug) =>
		[...new Set(profile(slug).code?.map((sample) => sample.language))].sort();
	expect(languages("sdk")).toEqual(["ts"]);
	expect(languages("cli")).toEqual(["bash"]);
	expect(languages("mcp")).toEqual(["http", "json"]);
	expect(languages("skills")).toEqual(["http", "yaml"]);

	const ids = PROFILE_SLUGS.flatMap((slug) => profile(slug).code ?? []).map(
		(sample) => sample.id
	);
	expect(new Set(ids).size).toBe(ids.length);
	for (const slug of PROFILE_SLUGS) {
		for (const id of profile(slug).code?.map((sample) => sample.id) ?? []) {
			expect(id.startsWith(`${slug}-`)).toBe(true);
		}
	}
	const firstSteps = PROFILE_SLUGS.map(
		(slug) => profile(slug).quickstart?.[0]?.title
	);
	expect(new Set(firstSteps).size).toBe(PROFILE_SLUGS.length);
});

test("CLI commands use ryu-cli, never the SDK's own ryu command", () => {
	const lines = [
		...(profile("cli").code ?? []).flatMap((sample) => sample.code.split("\n")),
		...(profile("cli").quickstart ?? []).flatMap((step) => step.command ?? []),
	];
	for (const line of lines.filter((value) => !value.startsWith(" "))) {
		expect(line).toMatch(/^ryu-cli\b/);
	}
});

test("the SDK says which commands are newer than its npm release", () => {
	const sdk = profile("sdk");
	expect(sdk.facts.find((fact) => fact.label === "On npm")?.value).toContain(
		"0.3.0"
	);
	const install = sdk.quickstart?.find((step) =>
		step.command?.startsWith("bunx ryu install")
	);
	expect(install?.description).toContain("newer than the 0.3.0 release");
});

test("the MCP page shows all three ways in, and only placeholder credentials", () => {
	const code = profile("mcp").code ?? [];
	expect(code.map((sample) => sample.label)).toEqual([
		"Stdio bridge",
		"Direct HTTP",
		"Managed node",
	]);
	const config = JSON.parse(code[0]?.code ?? "{}") as {
		mcpServers: Record<string, { command: string; args: string[] }>;
	};
	expect(config.mcpServers.ryu).toMatchObject({
		command: "ryu-mcp",
		args: ["serve"],
	});
	const text = code.map((sample) => sample.code).join("\n");
	expect(text).toContain("<node-or-paired-token>");
	expect(text).not.toMatch(/ryu_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]/);
});

test("the Skills sample is a valid SKILL.md with front-matter first", () => {
	const skill = profile("skills").code?.find(
		(sample) => sample.filename === "SKILL.md"
	);
	const [opening, frontMatter, body] = skill?.code.split(/^---$/m) ?? [];
	expect(opening).toBe("");
	expect(frontMatter).toContain('name: "Web Researcher"');
	expect(body?.trim().length).toBeGreaterThan(0);
	// Skills has no Read the docs button, so its docs links carry the page.
	const product = getProduct("skills");
	expect(product ? productDocsPath(product) : "missing").toBeUndefined();
});

test("comparisons sit in the right category for each tool", () => {
	const categories = (slug: ProfileSlug) =>
		new Set((profile(slug).compareSlugs ?? []).map(compareCategory));
	expect([...categories("sdk")]).toEqual(["Agent Builders & Automation"]);
	expect([...categories("cli")]).toEqual(["Coding Agents"]);
	expect(profile("mcp").compareSlugs).toEqual(["composio"]);
	expect(profile("skills").compareSlugs).toBeUndefined();
});
