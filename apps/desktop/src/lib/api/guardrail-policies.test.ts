import { afterEach, describe, expect, test } from "bun:test";
import { emptyPolicyRules } from "@ryu/blocks/desktop/guardrails/policy-model.ts";
import {
	desktopPolicyWorkspaceClient,
	GUARDRAIL_STEP_UP_REQUIRED,
	GuardrailPolicyRequestError,
	loadPolicyScopeOptions,
	runGuardrailWrite,
} from "./guardrail-policies.ts";

const originalFetch = globalThis.fetch;
const session = {
	baseUrl: "http://control-plane.test/",
	token: () => "account-session",
};

interface Captured {
	authorization: string | null;
	body: unknown;
	method: string;
	url: string;
}

function stubFetch(
	respond: (url: string, method: string) => { body: unknown; status: number }
): Captured[] {
	const calls: Captured[] = [];
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			calls.push({
				authorization: new Headers(init?.headers).get("Authorization"),
				body: init?.body ? JSON.parse(String(init.body)) : null,
				method,
				url,
			});
			const { body, status } = respond(url, method);
			return new Response(JSON.stringify(body), { status });
		},
		{ preconnect: originalFetch.preconnect }
	);
	return calls;
}

function wirePolicy(overrides: Record<string, unknown>) {
	return {
		archivedAt: null,
		assignments: [],
		createdAt: "2026-10-23T00:00:00.000Z",
		createdBy: "u",
		description: "",
		enforcesNothing: true,
		id: "gp_1",
		locked: [],
		name: "Baseline",
		rules: {
			allowedRegions: [],
			approvedModels: [],
			approvedProviders: [],
			budgets: [],
			evaluators: [],
			firewall: { enabled: true },
			permissions: [],
			zeroDataRetention: null,
		},
		updatedAt: "2026-10-23T00:00:00.000Z",
		updatedBy: "u",
		version: 1,
		...overrides,
	};
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("desktop guardrail policy client", () => {
	test("lists live policies with the session bearer", async () => {
		const calls = stubFetch(() => ({
			body: {
				assignments: [],
				policies: [
					wirePolicy({}),
					wirePolicy({ archivedAt: "2026-10-23T00:00:00.000Z", id: "gp_2" }),
				],
			},
			status: 200,
		}));
		const policies = await desktopPolicyWorkspaceClient(
			session,
			"org 1"
		).list();
		expect(policies.map((policy) => policy.id)).toEqual(["gp_1"]);
		expect(policies[0]?.rules.firewall).toEqual({ enabled: true });
		expect(calls[0]?.authorization).toBe("Bearer account-session");
		expect(calls[0]?.url).toBe(
			"http://control-plane.test/api/control-plane/orgs/org%201/guardrail-policies"
		);
	});

	test("sends the expected version and surfaces a conflict code", async () => {
		const calls = stubFetch(() => ({
			body: { code: "version_conflict", error: "the policy changed" },
			status: 409,
		}));
		const failure = await desktopPolicyWorkspaceClient(session, "o")
			.update("gp_1", {
				description: "",
				expectedVersion: 4,
				locked: [],
				name: "Baseline",
				rules: emptyPolicyRules(),
			})
			.catch((error: unknown) => error);
		expect(calls[0]?.method).toBe("PUT");
		expect(calls[0]?.body).toMatchObject({ expectedVersion: 4 });
		expect(failure).toBeInstanceOf(GuardrailPolicyRequestError);
		expect((failure as GuardrailPolicyRequestError).code).toBe(
			"version_conflict"
		);
	});

	test("names a step-up refusal and retries only then", async () => {
		let attempts = 0;
		stubFetch(() => {
			attempts += 1;
			return attempts === 1
				? {
						body: { error: "STEP_UP_REQUIRED", scope: "org.features" },
						status: 403,
					}
				: { body: { deleted: true, id: "ga_1" }, status: 200 };
		});
		const client = desktopPolicyWorkspaceClient(session, "o");
		const scopes: string[] = [];
		const result = await runGuardrailWrite(
			async (scope, action) => {
				scopes.push(scope);
				return await action();
			},
			() => client.unassign("ga_1")
		);
		expect(result).toEqual({ deleted: true, id: "ga_1" });
		expect(scopes).toEqual(["org.features"]);
		expect(GUARDRAIL_STEP_UP_REQUIRED).toBe("STEP_UP_REQUIRED");
	});

	test("scope options survive a source the viewer cannot read", async () => {
		stubFetch((url) => {
			if (url.endsWith("/gateway-keys")) {
				return { body: { error: "forbidden" }, status: 403 };
			}
			if (url.endsWith("/members")) {
				return {
					body: { members: [{ role: "admin", userId: "u1" }] },
					status: 200,
				};
			}
			return {
				body: { name: "Acme", teams: [{ id: "t1", name: "Platform" }] },
				status: 200,
			};
		});
		const options = await loadPolicyScopeOptions(session, "o");
		expect(options.org).toEqual([{ id: "o", label: "Acme" }]);
		expect(options.team).toEqual([{ id: "t1", label: "Platform" }]);
		expect(options.member).toEqual([{ id: "u1", label: "u1 (admin)" }]);
		expect(options.key).toEqual([]);
	});
});
