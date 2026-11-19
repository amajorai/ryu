// `ryu secrets …` dispatch tests: card approvals and password-manager accounts and reads. Core is faked through the
// target's injected `fetch`, child processes through `spawn`, and stdin
// through `readStdin`, so nothing touches a node, spawns, or reads the real
// terminal. Shared fixtures are in `secrets-dispatch-fixture.ts`.

import { expect, test } from "bun:test";
import { runCli } from "../cli/dispatch.ts";

import { fakeNode, makeIo, stubApi, T } from "./secrets-dispatch-fixture.ts";

const cardApproval = {
	id: "cap_1",
	itemId: "itm_1",
	environment: "default",
	path: "/",
	key: "visa",
	brand: "visa",
	last4: "4242",
	channel: "broker",
	merchantHost: "shop.example.com",
	requester: "broker_session:bvs_1",
	agent: "machine:m1",
	status: "pending",
	uses: 0,
	requestedAt: T,
	requestExpiresAt: T,
};

test("secrets items put --type card reads the number and CVC from stdin only", async () => {
	const node = fakeNode({
		"PUT /api/vault/items/visa": () =>
			Response.json(
				{
					item: {
						id: "itm_1",
						environment: "default",
						path: "/",
						key: "visa",
						kind: "card",
						version: 1,
						status: "ready",
						fields: [],
						availableOperations: [],
						card: {
							brand: "visa",
							last4: "4242",
							expired: false,
							merchants: ["shop.example.com"],
							placeholders: {},
						},
						createdAt: T,
						updatedAt: T,
					},
				},
				{ status: 201 }
			),
	});
	const run = async (args: string[], stdin: string | null) => {
		const cap = makeIo();
		const code = await runCli(["secrets", ...args], {
			api: stubApi(),
			io: cap.io,
			readStdin: () => Promise.resolve(stdin),
			target: node.target,
		});
		return { code, out: cap.out(), err: cap.err() };
	};
	const base = [
		"items",
		"put",
		"visa",
		"--type",
		"card",
		"--cardholder",
		"Ada Lovelace",
		"--exp",
		"07/31",
		"--merchant",
		"shop.example.com",
		"--merchant",
		"*.pay.example",
		"--country",
		"us",
	];
	const put = await run(base, "4242 4242 4242 4242\n123\n");
	expect(put.code).toBe(0);
	expect(put.out).toBe("Stored card visa (visa ending 4242, version 1).\n");
	expect(node.calls[0]?.body).toEqual({
		kind: "card",
		merchants: ["shop.example.com", "*.pay.example"],
		values: {
			cardholder: "Ada Lovelace",
			number: "4242 4242 4242 4242",
			expMonth: "07",
			expYear: "31",
			cvc: "123",
			country: "us",
		},
	});
	// A terminal stdin, a card number argument, or --field are refused
	// before anything is sent.
	expect((await run(base, null)).code).toBe(2);
	expect((await run([...base, "--number", "4242"], "x\n")).code).toBe(2);
	expect((await run([...base, "--cvc=123"], "x\n")).code).toBe(2);
	expect((await run([...base, "--field", "a=b"], "x\n")).code).toBe(2);
	expect((await run(base, "1\n2\n3\n")).code).toBe(2);
	expect(node.calls).toHaveLength(1);
});

test("secrets cards approvals list, approve, reject, and revoke", async () => {
	const node = fakeNode({
		"GET /api/vault/cards/approvals": { approvals: [cardApproval] },
		"POST /api/vault/cards/approvals/cap_1/approve": {
			approval: {
				...cardApproval,
				status: "approved",
				mode: "grant",
				grantSubject: "machine:m1",
				maxUses: 3,
			},
		},
		"POST /api/vault/cards/approvals/cap_1/reject": {
			approval: { ...cardApproval, status: "rejected" },
		},
		"POST /api/vault/cards/approvals/cap_1/revoke": {
			approval: { ...cardApproval, status: "revoked" },
		},
		"POST /api/vault/items/visa/reveal": () =>
			Response.json(
				{
					ok: true,
					status: "approval_required",
					approval: { ...cardApproval, channel: "reveal", merchantHost: "" },
					approvePath: "/api/vault/cards/approvals/cap_1/approve",
				},
				{ status: 202 }
			),
	});
	const run = async (args: string[]) => {
		const cap = makeIo();
		const code = await runCli(["secrets", ...args], {
			api: stubApi(),
			io: cap.io,
			target: node.target,
		});
		return { code, out: cap.out(), err: cap.err() };
	};
	const listed = await run(["cards", "approvals", "--env", "default"]);
	expect(listed.code).toBe(0);
	expect(listed.out).toContain("shop.example.com");
	expect(listed.out).toContain("visa 4242");
	const approved = await run([
		"cards",
		"approvals",
		"approve",
		"cap_1",
		"--mode",
		"grant",
		"--subject",
		"agent",
		"--ttl",
		"30m",
		"--max-uses",
		"3",
	]);
	expect(approved.out).toBe(
		"Approved card approval cap_1 (grant for machine:m1 at shop.example.com, 3 uses).\n"
	);
	expect(
		(await run(["cards", "approvals", "reject", "cap_1", "--reason", "no"])).out
	).toBe("Rejected card approval cap_1.\n");
	expect((await run(["cards", "approvals", "revoke", "cap_1"])).code).toBe(0);
	expect(
		(await run(["cards", "approvals", "approve", "cap_1", "--mode", "x"])).code
	).toBe(2);
	const reveal = await run(["items", "reveal", "visa", "number"]);
	expect(reveal.code).toBe(1);
	expect(reveal.out).toBe("");
	expect(reveal.err).toContain("ryu secrets cards approvals approve cap_1");
	expect(node.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"GET /api/vault/cards/approvals?status=pending&environment=default",
		"POST /api/vault/cards/approvals/cap_1/approve",
		"POST /api/vault/cards/approvals/cap_1/reject",
		"POST /api/vault/cards/approvals/cap_1/revoke",
		"POST /api/vault/items/visa/reveal",
	]);
	expect(node.calls[1]?.body).toEqual({
		mode: "grant",
		subject: "agent",
		ttlSecs: 1800,
		maxUses: 3,
	});
	expect(node.calls[2]?.body).toEqual({ note: "no" });
});

const pmAccount = {
	id: "pma_1",
	name: "work",
	provider: "bitwarden-sm",
	address: null,
	binaryPath: "/usr/local/bin/bws",
	state: "connected",
	lastError: null,
	lastCheckedAt: null,
	createdAt: T,
	updatedAt: T,
};
const pmApproval = {
	id: "bpr_1",
	environment: "default",
	status: "pending",
	message: "user:u1 asks to use bws://work@x",
	services: [],
	credentials: [],
	requestedBy: "user:u1",
	createdAt: T,
	expiresAt: T,
	credentialUse: {
		ref: "bws://work@2b7f2c5e-1a3d-4c4e-9b8a-0123456789ab",
		accountId: "pma_1",
		account: "work",
		provider: "bitwarden-sm",
		subject: "user:u1",
	},
};
const pmGrant = {
	id: "pmg_1",
	subject: "user:u1",
	accountId: "pma_1",
	account: "work",
	ref: "bws://work@2b7f2c5e-1a3d-4c4e-9b8a-0123456789ab",
	mode: "24h",
	usesRemaining: null,
	expiresAt: T,
	grantedBy: "operator",
	proposalId: "bpr_1",
	createdAt: T,
	revokedAt: null,
};

test("secrets pm add reads the token from stdin only and manages accounts", async () => {
	const node = fakeNode({
		"GET /api/vault/password-managers/accounts": { accounts: [pmAccount] },
		"POST /api/vault/password-managers/accounts": { account: pmAccount },
		"POST /api/vault/password-managers/accounts/pma_1/test": {
			ok: false,
			error: "`bws` rejected the account token (exited with status 1)",
			account: { ...pmAccount, state: "reconnect_required" },
		},
		"POST /api/vault/password-managers/accounts/pma_1/token": {
			account: pmAccount,
		},
		"DELETE /api/vault/password-managers/accounts/pma_1": { deleted: true },
	});
	const run = async (args: string[], stdin: string | null = null) => {
		const cap = makeIo();
		const code = await runCli(["secrets", "pm", ...args], {
			api: stubApi(),
			io: cap.io,
			readStdin: () => Promise.resolve(stdin),
			target: node.target,
		});
		return { code, out: cap.out(), err: cap.err() };
	};
	// No token on a terminal: refused before any call.
	const tty = await run(["add", "work", "--provider", "bitwarden-sm"]);
	expect(tty.code).toBe(2);
	expect(tty.err).toContain("never accepted as an argument");
	expect(
		(await run(["add", "work", "--provider", "lastpass"], "t\n")).code
	).toBe(2);
	const added = await run(
		["add", "work", "--provider", "bitwarden-sm"],
		"bws-token-1\n"
	);
	expect(added.code).toBe(0);
	expect(added.out).not.toContain("bws-token-1");
	const listed = await run(["accounts"]);
	expect(listed.out).toContain("bitwarden-sm");
	const tested = await run(["test", "work"]);
	expect(tested.code).toBe(1);
	expect(tested.err).toContain("reconnect_required");
	expect((await run(["reconnect", "work"], "bws-token-2\n")).code).toBe(0);
	expect((await run(["remove", "work"])).code).toBe(0);
	expect((await run(["test", "missing"])).code).toBe(2);
	expect(node.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"POST /api/vault/password-managers/accounts",
		"GET /api/vault/password-managers/accounts",
		"GET /api/vault/password-managers/accounts",
		"POST /api/vault/password-managers/accounts/pma_1/test",
		"GET /api/vault/password-managers/accounts",
		"POST /api/vault/password-managers/accounts/pma_1/token",
		"GET /api/vault/password-managers/accounts",
		"DELETE /api/vault/password-managers/accounts/pma_1",
		"GET /api/vault/password-managers/accounts",
	]);
	expect(node.calls[0]?.body).toEqual({
		name: "work",
		provider: "bitwarden-sm",
		token: "bws-token-1",
	});
	expect(node.calls[5]?.body).toEqual({ token: "bws-token-2" });
	expect(node.calls.some((call) => call.path.includes("bws-token"))).toBe(
		false
	);
});

test("secrets pm read waits for approval, and approvals and grants are managed", async () => {
	let approved = false;
	const node = fakeNode({
		"POST /api/vault/password-managers/read": () =>
			approved
				? Response.json({
						value: "bw-secret-value",
						ref: pmGrant.ref,
						account: "work",
						provider: "bitwarden-sm",
					})
				: Response.json(
						{ pending: true, approval: pmApproval },
						{ status: 202 }
					),
		"GET /api/vault/password-managers/approvals": { approvals: [pmApproval] },
		"POST /api/vault/password-managers/approvals/bpr_1/approve": () => {
			approved = true;
			return Response.json({
				approved: true,
				proposal: "bpr_1",
				grant: pmGrant,
			});
		},
		"POST /api/vault/password-managers/approvals/bpr_1/reject": {
			rejected: true,
		},
		"GET /api/vault/password-managers/grants": { grants: [pmGrant] },
		"DELETE /api/vault/password-managers/grants/pmg_1": {
			revoked: true,
			grant: { ...pmGrant, revokedAt: T },
		},
	});
	const run = async (args: string[]) => {
		const cap = makeIo();
		const code = await runCli(["secrets", "pm", ...args], {
			api: stubApi(),
			io: cap.io,
			target: node.target,
		});
		return { code, out: cap.out(), err: cap.err() };
	};
	const ref = "bws://2b7f2c5e-1a3d-4c4e-9b8a-0123456789ab";
	const waiting = await run(["read", ref, "--env", "prod"]);
	expect(waiting.code).toBe(3);
	expect(waiting.out).toBe("");
	expect(waiting.err).toContain("bpr_1");
	const listed = await run(["approvals"]);
	expect(listed.out).toContain("user:u1");
	expect(
		(await run(["approvals", "approve", "bpr_1", "--grant", "weekly"])).code
	).toBe(2);
	const decided = await run([
		"approvals",
		"approve",
		"bpr_1",
		"--grant",
		"24h",
	]);
	expect(decided.out).toContain("(24h)");
	const read = await run(["read", ref]);
	expect(read.code).toBe(0);
	expect(read.out).toBe("bw-secret-value\n");
	await run(["approvals", "reject", "bpr_1", "--reason", "no"]);
	expect((await run(["grants", "--all"])).out).toContain("pmg_1");
	expect((await run(["grants", "revoke", "pmg_1"])).out).toContain(
		"must ask again"
	);
	expect(node.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"POST /api/vault/password-managers/read",
		"GET /api/vault/password-managers/approvals?status=pending",
		"POST /api/vault/password-managers/approvals/bpr_1/approve",
		"POST /api/vault/password-managers/read",
		"POST /api/vault/password-managers/approvals/bpr_1/reject",
		"GET /api/vault/password-managers/grants?all=true",
		"DELETE /api/vault/password-managers/grants/pmg_1",
	]);
	expect(node.calls[0]?.body).toEqual({ ref, environment: "prod" });
	expect(node.calls[2]?.body).toEqual({ grant: "24h" });
	expect(node.calls[4]?.body).toEqual({ note: "no" });
});

// ── Shared values that need a step-up ────────────────────────────────────────
