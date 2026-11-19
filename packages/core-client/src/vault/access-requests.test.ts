import { expect, test } from "bun:test";
import type { ApiTarget } from "../client.ts";
import {
	createVaultAccessRequest,
	decideVaultAccessRequest,
	getVaultAccessRequest,
	listVaultAccessPolicies,
	listVaultAccessRequests,
} from "./access-requests.ts";

interface Call {
	body: string;
	method: string;
	path: string;
}

function node(reply: (call: Call) => Response) {
	const calls: Call[] = [];
	const target: ApiTarget = {
		url: "http://node.test",
		token: "node-token",
		fetch: (input, init) => {
			const url = new URL(String(input));
			const call = {
				method: init?.method ?? "GET",
				path: `${url.pathname}${url.search}`,
				body: String(init?.body ?? ""),
			};
			calls.push(call);
			return Promise.resolve(reply(call));
		},
	};
	return { calls, target };
}

/** The wire shape Core renders: RFC 3339 `…At` fields, optional fields absent. */
const PENDING = {
	id: "ar_1",
	requester: "user:alice",
	environment: "prod",
	path: "prod/payments/**",
	capabilities: ["read"],
	durationSecs: 3600,
	reason: "incident 42",
	policies: ["payments"],
	steps: [{ name: "payments/leads", approvers: ["team:leads"], approvals: 1 }],
	approvals: [],
	status: "pending",
	currentStep: "payments/leads",
	createdAt: "2026-01-01T00:00:00Z",
	expiresAt: "2026-01-02T00:00:00Z",
};

test("create posts the request body and returns the pending request", async () => {
	const fake = node(() =>
		Response.json({ ok: true, accessRequest: PENDING }, { status: 201 })
	);
	const result = await createVaultAccessRequest(fake.target, {
		path: "prod/payments/**",
		capabilities: ["read"],
		durationSecs: 3600,
		reason: "incident 42",
	});
	expect(result.accessRequest.status).toBe("pending");
	expect(result.accessRequest.currentStep).toBe("payments/leads");
	expect(fake.calls[0]?.method).toBe("POST");
	expect(fake.calls[0]?.path).toBe("/api/vault/access-requests");
	expect(JSON.parse(fake.calls[0]?.body ?? "")).toEqual({
		path: "prod/payments/**",
		capabilities: ["read"],
		durationSecs: 3600,
		reason: "incident 42",
	});
});

test("list and get parse granted requests with approvals and grant times", async () => {
	const granted = {
		...PENDING,
		status: "granted",
		currentStep: undefined,
		approvals: [
			{
				factor: "payments/leads",
				approver: "user:bob",
				approvedAt: "2026-01-01T00:05:00Z",
			},
		],
		decidedAt: "2026-01-01T00:05:00Z",
		decidedBy: "user:bob",
		grantPolicy: "access-ar_1",
		grantedAt: "2026-01-01T00:05:00Z",
		grantExpiresAt: "2026-01-01T01:05:00Z",
	};
	const fake = node((call) =>
		call.path === "/api/vault/access-requests"
			? Response.json({ accessRequests: [granted] })
			: Response.json({ accessRequest: granted })
	);
	const { accessRequests } = await listVaultAccessRequests(fake.target);
	expect(accessRequests[0]?.grantPolicy).toBe("access-ar_1");
	expect(accessRequests[0]?.approvals[0]?.approver).toBe("user:bob");
	const { accessRequest } = await getVaultAccessRequest(fake.target, "a r/1");
	expect(accessRequest.status).toBe("granted");
	expect(fake.calls[1]?.path).toBe("/api/vault/access-requests/a%20r%2F1");
});

test("decide posts to the action route, with a reason only when given", async () => {
	const fake = node(() =>
		Response.json({
			ok: true,
			accessRequest: { ...PENDING, status: "denied", decisionReason: "no" },
		})
	);
	const denied = await decideVaultAccessRequest(
		fake.target,
		"ar_1",
		"deny",
		"no"
	);
	expect(denied.accessRequest.decisionReason).toBe("no");
	await decideVaultAccessRequest(fake.target, "ar_1", "cancel");
	expect(fake.calls.map((call) => [call.path, call.body])).toEqual([
		["/api/vault/access-requests/ar_1/deny", JSON.stringify({ reason: "no" })],
		["/api/vault/access-requests/ar_1/cancel", "{}"],
	]);
});

test("a reply that is not an access request is rejected", async () => {
	const fake = node(() =>
		Response.json({ accessRequests: [{ ...PENDING, status: "canceled" }] })
	);
	await expect(listVaultAccessRequests(fake.target)).rejects.toThrow();
});

test("access policies list who approves what", async () => {
	const fake = node(() =>
		Response.json({
			accessPolicies: [
				{
					name: "payments",
					description: "",
					path: "prod/payments/**",
					capabilities: ["read", "write"],
					maxDurationSecs: 86_400,
					steps: [{ name: "leads", approvers: ["team:leads"], approvals: 2 }],
				},
			],
		})
	);
	const { accessPolicies } = await listVaultAccessPolicies(fake.target);
	expect(accessPolicies[0]?.steps[0]?.approvals).toBe(2);
	expect(accessPolicies[0]?.requestTtlSecs).toBeUndefined();
});
