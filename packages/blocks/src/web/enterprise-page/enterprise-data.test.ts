import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bannedCopyHits } from "../data/banned-copy.ts";
import { OPEN_SOURCE_REPOS } from "../data/company.ts";
import {
	normalizeWhitespace,
	repoRoot,
	resolveDocsPath,
} from "../product-page/profile-grounding.ts";
import type { ProductSource } from "../product-page/profile-types.ts";
import {
	ENTERPRISE_FACTS,
	ENTERPRISE_NAV,
	enterpriseCopyStrings,
	IDENTITY_ENDPOINTS,
	ROLLOUT_STEPS,
} from "./enterprise-data.ts";
import {
	DEPLOYMENT_OPTIONS,
	DEPLOYMENT_ROWS,
} from "./enterprise-deployment-data.ts";
import {
	ENTERPRISE_GATED_NOTE,
	ENTERPRISE_GROUPS,
} from "./enterprise-groups-data.ts";
import { ENTERPRISE_DOCS, ENTERPRISE_SOURCES } from "./enterprise-sources.ts";

const root = repoRoot();

function allSources(): { where: string; source: ProductSource }[] {
	const out: { where: string; source: ProductSource }[] = [
		{ where: "gated note", source: ENTERPRISE_GATED_NOTE.source },
	];
	for (const group of ENTERPRISE_GROUPS) {
		for (const item of group.items) {
			out.push({ where: `${group.id}/${item.title}`, source: item.source });
		}
	}
	for (const fact of ENTERPRISE_FACTS) {
		out.push({ where: `fact/${fact.label}`, source: fact.source });
	}
	for (const row of DEPLOYMENT_ROWS) {
		row.cells.forEach((cell, index) => {
			out.push({
				where: `deployment/${row.label}/${DEPLOYMENT_OPTIONS[index]?.id}`,
				source: cell.source,
			});
		});
	}
	for (const step of ROLLOUT_STEPS) {
		out.push({ where: `rollout/${step.title}`, source: step.source });
	}
	for (const sample of IDENTITY_ENDPOINTS) {
		out.push({ where: `endpoint/${sample.id}`, source: sample.source });
	}
	return out;
}

describe("enterprise page data is grounded in repo files", () => {
	test("every source file exists", () => {
		for (const path of Object.values(ENTERPRISE_SOURCES)) {
			expect(existsSync(join(root, path))).toBe(true);
		}
	});

	test("every quote appears verbatim (whitespace-normalised) in its source", () => {
		const missing: string[] = [];
		for (const { where, source } of allSources()) {
			const text = normalizeWhitespace(
				readFileSync(join(root, source.path), "utf8")
			);
			if (!(source.quote && text.includes(normalizeWhitespace(source.quote)))) {
				missing.push(`${where}: ${source.quote ?? "(no quote)"}`);
			}
		}
		expect(missing).toEqual([]);
	});

	test("every docs link resolves to a docs page", () => {
		for (const path of Object.values(ENTERPRISE_DOCS)) {
			expect(resolveDocsPath(path, root)).toBeDefined();
		}
		for (const group of ENTERPRISE_GROUPS) {
			expect(resolveDocsPath(group.docs.path, root)).toBeDefined();
		}
	});

	test("the identity endpoints are the documented URLs, unchanged", () => {
		for (const sample of IDENTITY_ENDPOINTS) {
			expect(sample.code).toContain(sample.source.quote);
		}
	});
});

describe("enterprise page copy", () => {
	test("uses no banned copy", () => {
		expect(bannedCopyHits(enterpriseCopyStrings())).toEqual([]);
	});

	test("claims no SLA, uptime figure, certification or customer", () => {
		const copy = enterpriseCopyStrings().join("\n");
		expect(copy).not.toMatch(
			/\bSLA\b|uptime|SOC ?2|ISO ?27001|HIPAA|PCI|\d+(?:\.\d+)?%|trusted by|customers/i
		);
	});

	test("has the three Vercel-style themed groups, in order", () => {
		expect(ENTERPRISE_GROUPS.map((group) => group.id)).toEqual([
			"governance",
			"security",
			"support",
		]);
		for (const group of ENTERPRISE_GROUPS) {
			expect(group.items.length).toBeGreaterThanOrEqual(4);
			expect(group.items.length).toBeLessThanOrEqual(6);
		}
	});

	test("tags only the controls the docs gate on an Enterprise entitlement", () => {
		const tagged = ENTERPRISE_GROUPS.flatMap((group) =>
			group.items.filter((item) => item.enterprise).map((item) => item.title)
		);
		expect(tagged).toEqual([
			"Single sign-on",
			"SCIM directory sync",
			"Audit log export",
			"Contracted data region",
		]);
		for (const group of ENTERPRISE_GROUPS) {
			for (const item of group.items.filter((entry) => entry.enterprise)) {
				const text = readFileSync(join(root, item.source.path), "utf8");
				expect(text).toContain("Enterprise");
			}
		}
	});

	test("compares the three documented deployment units, one cell per option", () => {
		expect(DEPLOYMENT_OPTIONS.map((option) => option.name)).toEqual([
			"Ryu Cloud",
			"Self-hosted Ryu Node",
			"Private/Full Ryu Deployment",
		]);
		for (const row of DEPLOYMENT_ROWS) {
			expect(row.cells).toHaveLength(DEPLOYMENT_OPTIONS.length);
		}
		expect(new Set(DEPLOYMENT_ROWS.map((row) => row.label)).size).toBe(
			DEPLOYMENT_ROWS.length
		);
	});

	test("the open-source fact follows the company repo list", () => {
		const repo = OPEN_SOURCE_REPOS.find(
			(entry) => entry.name === "amajorai/ryu"
		);
		const fact = ENTERPRISE_FACTS.find(
			(entry) => entry.label === "Open source"
		);
		expect(fact?.value).toBe(repo?.licenses.join(" and "));
		expect(fact?.href).toBe(repo?.href);
		expect(fact?.external).toBe(true);
	});

	test("sub-nav anchors are unique and the rollout has the docs' five steps", () => {
		const ids = ENTERPRISE_NAV.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ROLLOUT_STEPS).toHaveLength(5);
		expect(ROLLOUT_STEPS[0]?.title).toBe("Start small");
	});
});
