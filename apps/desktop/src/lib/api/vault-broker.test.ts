// Wire tests for the credential-broker and card spend-approval client: the
// exact URL, method and JSON body each function puts on a real loopback
// socket, and what it does with a malformed or refused reply. Every decision
// here is a data-changing, security-sensitive call, so the bytes are pinned
// rather than the call counts.

import { afterEach, expect, test } from "bun:test";
import { ApiError } from "./client.ts";
import {
	decideVaultBrokerProposal,
	decideVaultCardApproval,
	listVaultBrokerProposals,
	listVaultBrokerServices,
	listVaultCardApprovals,
	type VaultBrokerProposal,
	type VaultBrokerService,
	type VaultCardApproval,
	type VaultPasswordManagerGrantMode,
} from "./vault.ts";

interface Seen {
	authorization: string | null;
	body: string;
	method: string;
	target: string;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

/** A loopback node that answers every call with `reply` and records it. */
function node(reply: unknown, status = 200) {
	const seen: Seen[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			seen.push({
				authorization: request.headers.get("authorization"),
				body: await request.text(),
				method: request.method,
				target: `${url.pathname}${url.search}`,
			});
			return new Response(JSON.stringify(reply), {
				headers: { "content-type": "application/json" },
				status,
			});
		},
	});
	servers.push(server);
	return {
		seen,
		target: {
			token: "broker-node-token",
			url: `http://127.0.0.1:${server.port}`,
			userJwt: null,
		},
	};
}

const SERVICE: VaultBrokerService = {
	createdAt: "2026-10-01T00:00:00Z",
	description: "Payments sandbox",
	enabled: true,
	environment: "prod",
	host: "api.stripe.example",
	name: "stripe",
	pathPrefix: "/v1",
	port: 8443,
	updatedAt: "2026-10-02T00:00:00Z",
};

const PROPOSAL: VaultBrokerProposal = {
	createdAt: "2026-10-03T00:00:00Z",
	credentialUse: {
		account: "work",
		provider: "1password",
		ref: "op://Private/Stripe/key",
		subject: "agent:researcher",
	},
	credentials: [],
	environment: "prod",
	expiresAt: "2026-10-04T00:00:00Z",
	id: "prop-1",
	message: "Use the Stripe key",
	requestedBy: "agent:researcher",
	services: [],
	status: "pending",
};

const APPROVAL: VaultCardApproval = {
	agent: "researcher",
	brand: "visa",
	channel: "broker",
	environment: "prod",
	id: "appr-1",
	key: "TEAM_CARD",
	last4: "4242",
	merchantHost: "shop.example",
	requestExpiresAt: "2026-10-04T00:00:00Z",
	requestedAt: "2026-10-03T00:00:00Z",
	requester: "agent:researcher",
	status: "pending",
};

test("listing the broker's services is a bare GET that returns the services", async () => {
	const { seen, target } = node({ services: [SERVICE] });
	expect(await listVaultBrokerServices(target)).toEqual([SERVICE]);
	expect(seen).toEqual([
		{
			authorization: "Bearer broker-node-token",
			body: "",
			method: "GET",
			target: "/api/vault/broker/services",
		},
	]);
});

test("an older Core that omits the list answers with an empty array for all three lists", async () => {
	const { target } = node({});
	expect(await listVaultBrokerServices(target)).toEqual([]);
	expect(await listVaultBrokerProposals(target)).toEqual([]);
	expect(await listVaultCardApprovals(target)).toEqual([]);
});

test("proposals and card approvals are listed pending-only", async () => {
	const proposals = node({ proposals: [PROPOSAL] });
	expect(await listVaultBrokerProposals(proposals.target)).toEqual([PROPOSAL]);
	expect(proposals.seen.map(({ method, target }) => [method, target])).toEqual([
		["GET", "/api/vault/broker/proposals?status=pending"],
	]);

	const approvals = node({ approvals: [APPROVAL] });
	expect(await listVaultCardApprovals(approvals.target)).toEqual([APPROVAL]);
	expect(approvals.seen.map(({ method, target }) => [method, target])).toEqual([
		["GET", "/api/vault/cards/approvals?status=pending"],
	]);
});

test("list replies that break the schema surface instead of rendering partial rows", async () => {
	const unknownStatus = node({ proposals: [{ ...PROPOSAL, status: "maybe" }] });
	await expect(
		listVaultBrokerProposals(unknownStatus.target)
	).rejects.toThrow();

	const missingId = node({ proposals: [{ ...PROPOSAL, id: undefined }] });
	await expect(listVaultBrokerProposals(missingId.target)).rejects.toThrow();

	const badChannel = node({ approvals: [{ ...APPROVAL, channel: "email" }] });
	await expect(listVaultCardApprovals(badChannel.target)).rejects.toThrow();

	const badField = node({ approvals: [{ ...APPROVAL, field: "pin" }] });
	await expect(listVaultCardApprovals(badField.target)).rejects.toThrow();

	const badService = node({ services: [{ ...SERVICE, enabled: "yes" }] });
	await expect(listVaultBrokerServices(badService.target)).rejects.toThrow();

	const notAnObject = node(["not", "an", "object"]);
	await expect(listVaultBrokerProposals(notAnObject.target)).rejects.toThrow();
});

test("a refused list carries the status and Core's sentence", async () => {
	const { target } = node(
		{
			error: "vault_denied: the `list` capability is required on `sys/broker`",
		},
		403
	);
	const failure = await listVaultBrokerProposals(target).catch(
		(error: unknown) => error
	);
	expect(failure).toBeInstanceOf(ApiError);
	expect((failure as ApiError).status).toBe(403);
	expect((failure as ApiError).serverMessage).toContain(
		"the `list` capability is required on `sys/broker`"
	);
});

test("rejecting a proposal posts an empty object to the reject route and never a grant", async () => {
	const { seen, target } = node({ ok: true });
	await decideVaultBrokerProposal(target, "prop-1", "reject");
	// A grant passed alongside a rejection is dropped on the wire.
	await decideVaultBrokerProposal(target, "prop-2", "reject", "30d");
	expect(
		seen.map(({ body, method, target: path }) => [method, path, body])
	).toEqual([
		["POST", "/api/vault/broker/proposals/prop-1/reject", "{}"],
		["POST", "/api/vault/broker/proposals/prop-2/reject", "{}"],
	]);
});

test("approving a plain proposal posts an empty object, so Core creates the services without a grant", async () => {
	const { seen, target } = node({ ok: true });
	await decideVaultBrokerProposal(target, "prop-1", "approve");
	expect(seen).toEqual([
		{
			authorization: "Bearer broker-node-token",
			body: "{}",
			method: "POST",
			target: "/api/vault/broker/proposals/prop-1/approve",
		},
	]);
});

test("approving with a grant posts exactly that grant, for every lifetime", async () => {
	const { seen, target } = node({ ok: true });
	const grants: VaultPasswordManagerGrantMode[] = ["once", "1h", "24h", "30d"];
	for (const grant of grants) {
		await decideVaultBrokerProposal(target, "prop-1", "approve", grant);
	}
	expect(seen.map((call) => [call.method, call.target, call.body])).toEqual(
		grants.map((grant) => [
			"POST",
			"/api/vault/broker/proposals/prop-1/approve",
			JSON.stringify({ grant }),
		])
	);
});

test("proposal ids are percent-encoded into one path segment", async () => {
	const { seen, target } = node({ ok: true });
	await decideVaultBrokerProposal(target, "a/b c?x=1#frag", "approve", "1h");
	await decideVaultBrokerProposal(target, "../admin", "reject");
	expect(seen.map((call) => call.target)).toEqual([
		"/api/vault/broker/proposals/a%2Fb%20c%3Fx%3D1%23frag/approve",
		"/api/vault/broker/proposals/..%2Fadmin/reject",
	]);
});

test("a refused proposal decision rejects with the status and message", async () => {
	const { target } = node(
		{
			error: "vault_denied: the `admin` capability is required on `sys/broker`",
		},
		403
	);
	const failure = await decideVaultBrokerProposal(
		target,
		"prop-1",
		"approve"
	).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(ApiError);
	expect((failure as ApiError).status).toBe(403);
	expect((failure as ApiError).serverMessage).toContain("`admin` capability");
});

test("rejecting a card use posts an empty object to the reject route", async () => {
	const { seen, target } = node({ ok: true });
	await decideVaultCardApproval(target, "appr-1", "reject");
	expect(seen).toEqual([
		{
			authorization: "Bearer broker-node-token",
			body: "{}",
			method: "POST",
			target: "/api/vault/cards/approvals/appr-1/reject",
		},
	]);
});

test("approving a card once asks for mode once and nothing else", async () => {
	const { seen, target } = node({ ok: true });
	await decideVaultCardApproval(target, "appr-1", "once");
	expect(seen.map((call) => [call.method, call.target, call.body])).toEqual([
		["POST", "/api/vault/cards/approvals/appr-1/approve", '{"mode":"once"}'],
	]);
});

test("a card grant is scoped to the session and lasts 900 seconds", async () => {
	const { seen, target } = node({ ok: true });
	await decideVaultCardApproval(target, "appr-1", "grant");
	expect(seen.map((call) => [call.method, call.target, call.body])).toEqual([
		[
			"POST",
			"/api/vault/cards/approvals/appr-1/approve",
			'{"mode":"grant","subject":"session","ttlSecs":900}',
		],
	]);
});

test("card approval ids are percent-encoded into one path segment", async () => {
	const { seen, target } = node({ ok: true });
	await decideVaultCardApproval(target, "x/y z", "once");
	await decideVaultCardApproval(target, "x/y z", "reject");
	expect(seen.map((call) => call.target)).toEqual([
		"/api/vault/cards/approvals/x%2Fy%20z/approve",
		"/api/vault/cards/approvals/x%2Fy%20z/reject",
	]);
});

test("a refused card decision rejects with the status and message", async () => {
	const { target } = node(
		{
			error:
				"vault_denied: the `write` capability is required on `default/TEAM_CARD`",
		},
		403
	);
	const failure = await decideVaultCardApproval(target, "appr-1", "once").catch(
		(error: unknown) => error
	);
	expect(failure).toBeInstanceOf(ApiError);
	expect((failure as ApiError).status).toBe(403);
	expect((failure as ApiError).serverMessage).toContain("`write` capability");
});
