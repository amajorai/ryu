import { expect, test } from "bun:test";
import {
	dispatchRpc,
	type HostServices,
	routeRegistrationRecordSchema,
} from "./rpc.ts";

test("route registration replies retain the acknowledged path and additive metadata", () => {
	const reply = { path: "/plugin/app", future: { surface: "web" } };
	expect(Object.is(routeRegistrationRecordSchema.parse(reply), reply)).toBe(
		true
	);
	for (const invalid of [
		null,
		{},
		{ path: 4 },
		{ path: "/plugin/app", future: () => null },
	]) {
		expect(routeRegistrationRecordSchema.safeParse(invalid).success).toBe(
			false
		);
	}
});

test("route dispatch still checks grants and input before the host own-route gate", async () => {
	const calls: string[] = [];
	const services: HostServices = {
		listAgents: async () => [],
		registerRoute: async (claim) => {
			calls.push(claim.path);
			if (claim.path !== "/plugin/app") {
				throw new Error("not this plugin's own surface");
			}
			return { path: claim.path };
		},
	};
	const grants = new Set(["ui.render"] as const);
	await expect(
		dispatchRpc(
			"ui.registerRoute",
			[{ path: "/plugin/app", title: "App" }],
			new Set(),
			services
		)
	).rejects.toThrow("Capability not granted");
	await expect(
		dispatchRpc("ui.registerRoute", [{ path: "/plugin/app" }], grants, services)
	).rejects.toThrow("requires a { path, title }");
	expect(calls).toEqual([]);
	await expect(
		dispatchRpc(
			"ui.registerRoute",
			[{ path: "/settings", title: "App" }],
			grants,
			services
		)
	).rejects.toThrow("not this plugin's own surface");
	await expect(
		dispatchRpc(
			"ui.registerRoute",
			[{ path: "/plugin/app", title: "App" }],
			grants,
			services
		)
	).resolves.toEqual({ path: "/plugin/app" });
	expect(calls).toEqual(["/settings", "/plugin/app"]);
});
