// `ryu-cli secrets share …`: one-time share and request links. Core is faked
// through the target's `fetch`.

import { expect, test } from "bun:test";
import { SHARE_USAGE } from "../cli/secrets-share.ts";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

const link = {
	expiresAt: "2026-11-10T00:00:00.000Z",
	id: "vs_1",
	url: "https://ryu.example/secret/TOKEN#KEY",
};

test("share prints the one-time link on stdout only", async () => {
	const node = fakeNode({ "POST /api/vault/shares": json({ link }) });
	const result = await runSecrets(
		[
			"share",
			"DB_PASSWORD",
			"--env",
			"prod",
			"--label",
			"Staging",
			"--ttl",
			"2h",
		],
		node
	);
	expect(result.code).toBe(0);
	expect(result.out).toBe(`${link.url}\n`);
	expect(result.err).toContain("works once");
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toMatchObject({
		environment: "prod",
		label: "Staging",
		name: "DB_PASSWORD",
		ttlSecs: 7200,
	});
}, 30_000);

test("an AI agent session cannot create a share link but can list them", async () => {
	const node = fakeNode({
		"GET /api/vault/shares": json({ links: [] }),
		"POST /api/vault/shares": json({ link }),
	});
	const refused = await runSecrets(["share", "DB_PASSWORD"], node, {
		env: { CLAUDECODE: "1" },
	});
	expect(refused.code).not.toBe(0);
	expect(refused.out).not.toContain(link.url);
	const wrapped = await runSecrets(["share", "--wrap-token", "rvw_x"], node, {
		env: { CLAUDECODE: "1" },
	});
	expect(wrapped.code).not.toBe(0);
	expect(node.calls.some((call) => call.route.startsWith("POST "))).toBe(false);
	const listed = await runSecrets(["share", "list"], node, {
		env: { CLAUDECODE: "1" },
	});
	expect(listed.code).toBe(0);
	expect(listed.out).toContain("No share links.");
}, 30_000);

test("request, claim and revoke", async () => {
	const node = fakeNode({
		"DELETE /api/vault/shares/vs_1": json({ revoked: false }),
		"POST /api/vault/share-requests": json({
			link: {
				...link,
				id: "vr_1",
				url: "https://ryu.example/secret-request/T",
			},
		}),
		"POST /api/vault/shares/vr_1/claim": json({ ok: true }),
	});
	const asked = await runSecrets(
		["share", "request", "STRIPE_KEY", "--label", "Your Stripe key"],
		node
	);
	expect(asked.out).toBe("https://ryu.example/secret-request/T\n");
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toMatchObject({
		label: "Your Stripe key",
		name: "STRIPE_KEY",
	});
	const claimed = await runSecrets(["share", "claim", "vr_1"], node);
	expect(claimed.out).toContain("Saved the answer to request vr_1.");
	const revoked = await runSecrets(["share", "revoke", "vs_1"], node);
	expect(revoked.out).toContain("already used, expired, or revoked");
	const missingLabel = await runSecrets(["share", "request", "K"], node);
	expect(missingLabel.code).not.toBe(0);
	expect(missingLabel.err).toContain(SHARE_USAGE.slice("Usage: ".length));
}, 30_000);

test("request-credential asks for an agent's sign-in, also from an agent session", async () => {
	const node = fakeNode({
		"POST /api/vault/credential-requests": json({
			link: {
				...link,
				id: "vc_1",
				url: "https://ryu.example/secret-request/C",
			},
		}),
	});
	const asked = await runSecrets(
		[
			"share",
			"request-credential",
			"github.com",
			"--label",
			"Release bot",
			"--agent",
			"agent-1",
			"--username",
			"ops-bot",
			"--totp",
			"--submit-url",
			"https://github.com/session",
		],
		node,
		{ env: { CLAUDECODE: "1" } }
	);
	expect(asked.code).toBe(0);
	expect(asked.out).toBe("https://ryu.example/secret-request/C\n");
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toEqual({
		agentId: "agent-1",
		label: "Release bot",
		site: "github.com",
		submitUrls: ["https://github.com/session"],
		totp: true,
		username: "ops-bot",
	});
	const missingLabel = await runSecrets(
		["share", "request-credential", "github.com"],
		node
	);
	expect(missingLabel.code).not.toBe(0);
	expect(missingLabel.err).toContain(SHARE_USAGE.slice("Usage: ".length));
}, 30_000);
