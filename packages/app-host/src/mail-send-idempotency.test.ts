import { expect, test } from "bun:test";
import { asMailSendArg, dispatchRpc, type HostServices } from "./rpc.ts";

function unsupportedServices(
	calls: string[]
): Pick<HostServices, "listAgents" | "registerRoute"> {
	return {
		listAgents: async () => {
			calls.push("listAgents");
			throw new Error("Unexpected listAgents call");
		},
		registerRoute: async () => {
			calls.push("registerRoute");
			throw new Error("Unexpected registerRoute call");
		},
	};
}

const payload = {
	inboxId: "inbox-a",
	to: ["reviewed@example.test"],
	subject: "Reviewed",
	text: "Exact body",
};

test("canonical Mail key is preserved exactly and absent-key callers remain compatible", async () => {
	const calls: unknown[] = [];
	const unsupported: string[] = [];
	const services: HostServices = {
		...unsupportedServices(unsupported),
		mailSend: async (input) => {
			calls.push(input);
			return { id: "accepted" };
		},
	};
	const key = "retry key-with-interior-space";
	expect(asMailSendArg({ ...payload, idempotencyKey: key })).toEqual({
		...payload,
		idempotencyKey: key,
	});
	await dispatchRpc(
		"mail.send",
		[{ ...payload, idempotencyKey: key }],
		new Set(["mail.crud"]),
		services
	);
	await dispatchRpc("mail.send", [payload], new Set(["mail.crud"]), services);
	expect(calls).toEqual([{ ...payload, idempotencyKey: key }, payload]);
	expect(unsupported).toEqual([]);
});

test("malformed Mail retry keys and denied capability never reach the service", async () => {
	let calls = 0;
	const unsupported: string[] = [];
	const services: HostServices = {
		...unsupportedServices(unsupported),
		mailSend: async () => {
			calls += 1;
			throw new Error("unexpected service call");
		},
	};
	for (const key of [
		"",
		"   ",
		"x".repeat(257),
		"bad\r\nheader",
		"bad\tkey",
		"non-ascii-é",
		null,
		1,
	]) {
		expect(asMailSendArg({ ...payload, idempotencyKey: key })).toBeNull();
		await expect(
			dispatchRpc(
				"mail.send",
				[{ ...payload, idempotencyKey: key }],
				new Set(["mail.crud"]),
				services
			)
		).rejects.toThrow();
	}
	await expect(
		dispatchRpc(
			"mail.send",
			[{ ...payload, idempotencyKey: "allowed-key" }],
			new Set(),
			services
		)
	).rejects.toThrow();
	expect(calls).toBe(0);
	expect(unsupported).toEqual([]);
	expect(
		asMailSendArg({ ...payload, idempotencyKey: "x".repeat(256) })
			?.idempotencyKey
	).toHaveLength(256);
});
