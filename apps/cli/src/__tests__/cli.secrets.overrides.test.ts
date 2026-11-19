// `ryu-cli secrets overrides [status|on|off]`: reads and switches the caller's
// personal-overrides setting. Core is faked through the target's `fetch`.

import { expect, test } from "bun:test";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

const ROUTE = "/api/vault/personal-overrides";

function overridesNode(initial: boolean) {
	let enabled = initial;
	return fakeNode({
		[`GET ${ROUTE}`]: () => Response.json({ enabled, userId: "user-1" }),
		[`PUT ${ROUTE}`]: (call) => {
			enabled = (JSON.parse(call.body) as { enabled: boolean }).enabled;
			return Response.json({ enabled, userId: "user-1" });
		},
	});
}

test("status is the default action and says which values win", async () => {
	const node = overridesNode(true);
	const result = await runSecrets(["overrides"], node);
	expect(result.code).toBe(0);
	expect(result.out).toContain("Personal overrides are on for user-1");
	expect(node.calls.map((call) => call.route)).toEqual([`GET ${ROUTE}`]);

	const explicit = await runSecrets(["overrides", "status"], node);
	expect(explicit.out).toContain("are on");
});

test("off and on switch the setting with a PUT", async () => {
	const node = overridesNode(true);
	const off = await runSecrets(["overrides", "off"], node);
	expect(off.code).toBe(0);
	expect(off.out).toContain("Personal overrides are off for user-1");
	expect(node.calls.at(-1)).toMatchObject({
		route: `PUT ${ROUTE}`,
		body: '{"enabled":false}',
	});
	const status = await runSecrets(["overrides", "status"], node);
	expect(status.out).toContain("are off");

	const on = await runSecrets(["overrides", "on"], node);
	expect(on.out).toContain("are on");
	expect(node.calls.at(-1)?.body).toBe('{"enabled":true}');
});

test("--json prints the setting", async () => {
	const node = overridesNode(false);
	const result = await runSecrets(["overrides", "--json"], node);
	expect(result.code).toBe(0);
	expect(JSON.parse(result.out)).toEqual({ enabled: false, userId: "user-1" });
});

test("an unknown action is a usage error and calls nothing", async () => {
	const node = overridesNode(true);
	const result = await runSecrets(["overrides", "maybe"], node);
	expect(result.code).not.toBe(0);
	expect(result.err).toContain("secrets overrides [status|on|off]");
	expect(node.calls).toEqual([]);
});

test("a refusal from Core fails the command", async () => {
	const node = fakeNode({
		[`GET ${ROUTE}`]: () =>
			Response.json(
				{ error: "vault_denied: personal overrides need a signed-in user" },
				{ status: 403 }
			),
		[`PUT ${ROUTE}`]: json({}),
	});
	const result = await runSecrets(["overrides"], node);
	expect(result.code).not.toBe(0);
	expect(result.err).toContain("403");
});
