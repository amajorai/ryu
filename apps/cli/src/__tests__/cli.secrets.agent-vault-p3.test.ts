// Agent Vault P3 parity in the CLI: `broker service enable|disable`, the
// credential-usage check on `secrets delete`, and the `broker review`
// walker. Core is faked through the target's `fetch`.

import { expect, test } from "bun:test";
import type { VaultBrokerService } from "@ryuhq/core-client/vault";
import { parseChoice } from "../cli/secrets-broker-review.ts";
import { servicesReferencing } from "../cli/secrets-delete-usage.ts";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

const service = (name: string, auth: unknown, environment = "dev") => ({
	auth,
	createdAt: "2026-01-01T00:00:00Z",
	enabled: true,
	environment,
	host: `${name}.test`,
	name,
	pathPrefix: "/",
	updatedAt: "2026-01-01T00:00:00Z",
});

const proposal = (id: string) => ({
	createdAt: "2026-11-13T00:00:00Z",
	credentials: [],
	environment: "dev",
	expiresAt: "2026-11-14T00:00:00Z",
	id,
	message: `please add ${id}`,
	requestedBy: "agent:claude",
	services: [{ host: `${id}.test` }],
	status: "pending",
});

function answers(list: (string | null)[]) {
	const queue = [...list];
	return () =>
		Promise.resolve(queue.length > 0 ? (queue.shift() ?? null) : null);
}

test("disable keeps the definition and flips only enabled; enable twice is a no-op", async () => {
	const openai = service("openai", {
		token: "secret:OPENAI_KEY",
		type: "bearer",
	});
	const node = fakeNode({
		"GET /api/vault/broker/services/openai": json({ service: openai }),
		"PUT /api/vault/broker/services/openai": json({
			service: { ...openai, enabled: false },
		}),
	});
	const disabled = await runSecrets(
		["broker", "service", "disable", "openai"],
		node
	);
	expect(disabled.code).toBe(0);
	const put = node.calls.find((call) => call.route.startsWith("PUT"));
	const body = JSON.parse(put?.body ?? "{}");
	expect(body.enabled).toBe(false);
	expect(body.auth).toEqual(openai.auth);
	expect(body).not.toHaveProperty("updatedAt");

	const again = await runSecrets(
		["broker", "service", "enable", "openai"],
		node
	);
	expect(again.out).toContain("already enabled");
	expect(
		node.calls.filter((call) => call.route.startsWith("PUT"))
	).toHaveLength(1);
});

test("references are matched by whole name and environment", () => {
	const services = [
		service("a", { token: "secret:API_KEY", type: "bearer" }),
		service("b", { token: "secret:API_KEY_2", type: "bearer" }),
		service(
			"c",
			{ headers: { "X-Key": "{{secret:API_KEY}}" }, type: "custom" },
			"prod"
		),
		{
			...service("d", { type: "passthrough" }),
			substitutions: [{ ref: "secret:API_KEY" }],
		},
	] as unknown as VaultBrokerService[];
	expect(servicesReferencing(services, "API_KEY")).toEqual(["a", "c", "d"]);
	expect(servicesReferencing(services, "API_KEY", "prod")).toEqual(["c"]);
	expect(servicesReferencing(services, "OTHER")).toEqual([]);
});

test("delete refuses a value broker services use unless --force", async () => {
	const node = fakeNode({
		"GET /api/vault/broker/services": json({
			services: [
				service("github", { token: "secret:GH_TOKEN", type: "bearer" }),
			],
		}),
		"DELETE /api/vault/secrets/GH_TOKEN": json({
			binding: null,
			deleted: true,
			environment: "dev",
			name: "GH_TOKEN",
			ok: true,
			path: "/",
			scope: "user",
			scopeId: "local",
		}),
	});
	const refused = await runSecrets(["delete", "GH_TOKEN"], node);
	expect(refused.code).toBe(1);
	expect(refused.err).toContain("broker services use it (github)");
	expect(node.calls.some((call) => call.route.startsWith("DELETE"))).toBe(
		false
	);

	const forced = await runSecrets(["delete", "GH_TOKEN", "--force"], node);
	expect(forced.code).toBe(0);
	expect(node.calls.some((call) => call.route.startsWith("DELETE"))).toBe(true);
});

test("review approves, rejects with a reason, skips, and tallies", async () => {
	const node = fakeNode({
		"GET /api/vault/broker/proposals": json({
			proposals: [proposal("bp_1"), proposal("bp_2"), proposal("bp_3")],
		}),
		"POST /api/vault/broker/proposals/bp_1/approve": json({
			approved: true,
			proposal: "bp_1",
		}),
		"POST /api/vault/broker/proposals/bp_2/reject": json({ rejected: true }),
	});
	const result = await runSecrets(["broker", "review"], node, {
		promptLine: answers(["maybe", "a", "r", "not this week", "s"]),
	});
	expect(result.code).toBe(0);
	expect(result.out).toContain("[1/3]");
	expect(result.out).toContain("Approved proposal bp_1.");
	expect(result.out).toContain("Rejected proposal bp_2.");
	expect(result.out).toContain("1 approved, 1 rejected, 1 skipped");
	const reject = node.calls.find((call) => call.route.includes("reject"));
	expect(JSON.parse(reject?.body ?? "{}")).toEqual({ note: "not this week" });
});

test("review stops without a terminal and refuses in an agent session", async () => {
	const node = fakeNode({
		"GET /api/vault/broker/proposals": json({
			proposals: [proposal("bp_1")],
		}),
	});
	const headless = await runSecrets(["broker", "review"], node, {
		promptLine: answers([]),
	});
	expect(headless.code).toBe(1);
	expect(headless.err).toContain("needs a person");

	const agent = await runSecrets(["broker", "review"], fakeNode({}), {
		env: { CLAUDECODE: "1", HOME: "/home/me" },
	});
	expect(agent.code).toBe(1);
	expect(agent.err).toContain("Refusing to review broker proposals");
	expect(parseChoice(" Q ")).toBe("quit");
	expect(parseChoice("")).toBe("skip");
	expect(parseChoice("x")).toBeNull();
});
