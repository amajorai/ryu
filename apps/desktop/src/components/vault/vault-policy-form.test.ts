import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	boundSubjects,
	NEW_POLICY_DOCUMENT,
	parsePolicyForm,
	policyDocumentText,
	RULE_FIELDS,
} from "./vault-policy-form.ts";

const POLICY = {
	name: "ci",
	description: "CI reads",
	rules: [
		{
			path: "prod/**",
			capabilities: ["write"],
			allowedParameters: { region: ["eu-*"] },
			valueRules: { minLength: 16 },
		},
	],
};

test("the document keeps every rule field, so an edit drops none", () => {
	const text = policyDocumentText(POLICY);
	const parsed = parsePolicyForm("ci", text);
	expect(parsed).toEqual({
		ok: true,
		name: "ci",
		input: { description: "CI reads", rules: POLICY.rules },
	});
	expect(JSON.parse(policyDocumentText(null))).toEqual(NEW_POLICY_DOCUMENT);
});

test("names, JSON and the document shape are checked before anything is sent", () => {
	const good = policyDocumentText(POLICY);
	for (const name of ["", "CI", "a b", "x".repeat(65), "ci/read"]) {
		expect(parsePolicyForm(name, good)).toEqual({
			ok: false,
			problem: { kind: "name" },
		});
	}
	const broken = parsePolicyForm("ci", "{ rules: ");
	expect(broken.ok).toBe(false);
	expect(!broken.ok && broken.problem.kind).toBe("json");
	for (const text of ["[]", "{}", '{"rules": []}', '{"rules": [1]}', "null"]) {
		expect(parsePolicyForm("ci", text)).toEqual({
			ok: false,
			problem: { kind: "shape" },
		});
	}
	expect(
		parsePolicyForm(" ci ", '{"rules":[{"path":"a","capabilities":["read"]}]}')
	).toEqual({
		ok: true,
		name: "ci",
		input: { description: "", rules: [{ path: "a", capabilities: ["read"] }] },
	});
});

test("bound subjects are the policy's own live ones, sorted", () => {
	expect(
		boundSubjects(
			"ci",
			[
				{ policy: "ci", subject: "team:b" },
				{ policy: "other", subject: "user:x" },
				{ policy: "ci", subject: "machine:a" },
				{
					policy: "ci",
					subject: "user:gone",
					expiresAt: "2026-01-01T00:00:00Z",
				},
				{
					policy: "ci",
					subject: "user:soon",
					expiresAt: Date.parse("2027-01-01"),
				},
			],
			Date.parse("2026-06-01")
		)
	).toEqual(["machine:a", "team:b", "user:soon"]);
});

test("a misspelled rule field and a taken name are refused before saving", () => {
	const typo = JSON.stringify({
		rules: [{ path: "a", capabilities: ["write"], allowedParams: { x: [] } }],
	});
	expect(parsePolicyForm("ci", typo)).toEqual({
		ok: false,
		problem: { kind: "field", field: "allowedParams" },
	});
	const aliases = JSON.stringify({
		rules: [{ path: "a", capabilities: ["read"], minWrappingTtl: "5m" }],
	});
	expect(parsePolicyForm("ci", aliases).ok).toBe(true);
	expect(parsePolicyForm("ci", policyDocumentText(POLICY), ["ci"])).toEqual({
		ok: false,
		problem: { kind: "exists" },
	});
});

test("a non-text description or an extra top-level key is refused, not dropped", () => {
	const rules = [{ path: "a", capabilities: ["read"] }];
	expect(
		parsePolicyForm("ci", JSON.stringify({ description: 5, rules }))
	).toEqual({
		ok: false,
		problem: { kind: "description" },
	});
	expect(
		parsePolicyForm("ci", JSON.stringify({ rules, name: "other" }))
	).toEqual({
		ok: false,
		problem: { kind: "key", key: "name" },
	});
});

test("RULE_FIELDS matches Core's PolicyRule fields and aliases", () => {
	// Tie test: the editor's allow-list is hand-copied from the Rust struct,
	// so a field added there (or here) without the other fails this.
	const source = readFileSync(
		join(import.meta.dir, "../../../../../apps/core/src/vault/policy.rs"),
		"utf8"
	);
	const start = source.indexOf("pub struct PolicyRule {");
	const body = source.slice(start, source.indexOf("\n}\n", start));
	const camel = (name: string) =>
		name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
	const fields = [...body.matchAll(/^\s+pub ([a-z_]+):/gm)].map((match) =>
		camel(match[1] ?? "")
	);
	const aliases = [...body.matchAll(/alias = "([A-Za-z_]+)"/g)].map(
		(match) => match[1] ?? ""
	);
	expect(fields.length).toBeGreaterThan(5);
	expect([...RULE_FIELDS].sort()).toEqual([...fields, ...aliases].sort());
});
