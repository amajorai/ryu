// Drag-to-assign binding (spec 07.6, CV-7): a drop writes the same
// create-only assignment the forms send, an occupied scope answers with the
// forms' conflict notice, and a dismissed step-up prompt is a cancel.

import { describe, expect, test } from "bun:test";
import type { PolicyScopeOptions } from "../guardrails/policy-model.ts";
import type { CanvasNode } from "./model.ts";
import { policyCanvasAssignment } from "./policy-assignment.ts";

const OPTIONS: PolicyScopeOptions = {
	agent: [],
	key: [{ id: "key_ci", label: "CI (ryu_ci)" }],
	member: [],
	org: [{ id: "org_1", label: "Proof org" }],
	team: [
		{ id: "team_a", label: "Platform" },
		{ id: "team_b", label: "Research" },
	],
};

const POLICY = {
	assignments: [],
	description: "",
	id: "pol_1",
	locked: [],
	name: "Strict screening",
	rules: {
		allowedRegions: [],
		approvedModels: [],
		approvedProviders: [],
		budgets: [],
		evaluators: [],
		firewall: {},
		permissions: [],
		zeroDataRetention: null,
	},
	version: 1,
};

function layer(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
	return { id, kind: "scope", label: id, ...extra };
}

class Refusal extends Error {
	readonly code: string;
	readonly status: number;
	constructor(status: number, code: string) {
		super("refused");
		this.code = code;
		this.status = status;
	}
}

const passThrough = <T>(action: () => Promise<T>) => action();

const STORED = {
	id: "ga_1",
	policyId: "pol_1",
	scope: { id: "org_1", kind: "org" as const },
};

describe("policyCanvasAssignment", () => {
	test("each layer offers its own scopes; other nodes take none", () => {
		const assignment = policyCanvasAssignment({
			client: { assign: () => Promise.resolve(STORED) },
			policies: [POLICY],
			runWrite: passThrough,
			scopeOptions: OPTIONS,
		});
		expect(assignment.policies).toEqual([
			{ id: "pol_1", label: "Strict screening" },
		]);
		expect(assignment.targets(layer("scope:org"))).toEqual([
			{ id: "org_1", kind: "org", label: "Proof org" },
		]);
		expect(
			assignment.targets(
				layer("layer-teams", { ref: { scope: { id: "team", kind: "team" } } })
			)
		).toHaveLength(2);
		expect(assignment.targets(layer("scope:agent"))).toEqual([]);
		expect(
			assignment.targets({ id: "stage:node", kind: "stage", label: "x" })
		).toEqual([]);
	});

	test("CV-7: a drop creates and never replaces; a second gets the 409 notice", async () => {
		const sent: unknown[] = [];
		const taken = new Set<string>();
		const assignment = policyCanvasAssignment({
			client: {
				assign: (input) => {
					sent.push(input);
					const key = `${input.scope.kind}:${input.scope.id}`;
					if (taken.has(key)) {
						return Promise.reject(new Refusal(409, "scope_already_assigned"));
					}
					taken.add(key);
					return Promise.resolve(STORED);
				},
			},
			policies: [POLICY],
			runWrite: passThrough,
			scopeOptions: OPTIONS,
		});
		const key = { id: "key_ci", kind: "key", label: "CI" };
		expect(await assignment.assign("pol_1", key)).toBe(true);
		await expect(assignment.assign("pol_1", key)).rejects.toThrow(
			"That scope already has a policy. Replace it or remove it first."
		);
		expect(sent).toEqual([
			{ policyId: "pol_1", scope: { id: "key_ci", kind: "key" } },
			{ policyId: "pol_1", scope: { id: "key_ci", kind: "key" } },
		]);
	});

	test("a dismissed step-up prompt is a cancel, not an error", async () => {
		const assignment = policyCanvasAssignment({
			client: { assign: () => Promise.resolve(STORED) },
			policies: [POLICY],
			runWrite: () => Promise.resolve(null),
			scopeOptions: OPTIONS,
		});
		expect(
			await assignment.assign("pol_1", {
				id: "org_1",
				kind: "org",
				label: "Proof org",
			})
		).toBe(false);
	});
});
