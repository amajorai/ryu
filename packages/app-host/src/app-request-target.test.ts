import { describe, expect, test } from "bun:test";
import {
	type AppMountForwarder,
	appHttpGrantTarget,
	appRequestService,
	isScopedAppId,
	resolveAppRequestTarget,
} from "./app-request-target.ts";
import { ghostRecipesViaAppMount } from "./recipes-compat.ts";
import {
	asAppRequestArg,
	capabilitiesFromGrants,
	dispatchRpc,
	type HostServices,
	type RouteClaim,
} from "./rpc.ts";

const CALLER = "@ryu/workflows";
const RECIPES = "@ryu/recipes";

function recordingForwarder() {
	const calls: { pluginId: string; path: string; method: string }[] = [];
	const forward: AppMountForwarder = async (pluginId, input) => {
		calls.push({ method: input.method ?? "GET", path: input.path, pluginId });
		return { ok: true };
	};
	return { calls, forward };
}

function hostServices(appRequest: HostServices["appRequest"]): HostServices {
	return {
		appRequest,
		listAgents: () => Promise.resolve([]),
		registerRoute: (claim: RouteClaim) => Promise.resolve({ path: claim.path }),
	};
}

describe("app.request target", () => {
	test("scoped ids only, never a pattern", () => {
		expect(isScopedAppId(RECIPES)).toBe(true);
		expect(isScopedAppId("@ryu/*")).toBe(false);
		expect(isScopedAppId("com.ryu.recipes")).toBe(false);
		expect(isScopedAppId("@ryu/recipes/../x")).toBe(false);
		expect(appHttpGrantTarget("app:http:@ryu/recipes")).toBe(RECIPES);
		expect(appHttpGrantTarget("app:http:*")).toBeNull();
		expect(appHttpGrantTarget("app:http")).toBeNull();
	});

	test("own app is unchanged: app:http, with or without naming itself", () => {
		expect(resolveAppRequestTarget(CALLER, ["app:http"], undefined)).toEqual({
			allowed: true,
			pluginId: CALLER,
		});
		expect(resolveAppRequestTarget(CALLER, ["app:http"], CALLER)).toEqual({
			allowed: true,
			pluginId: CALLER,
		});
		// A per-target grant does not open the caller's own sidecar.
		expect(
			resolveAppRequestTarget(CALLER, ["app:http:@ryu/recipes"], undefined)
				.allowed
		).toBe(false);
	});

	test("another app needs its own reviewed per-target grant", () => {
		expect(
			resolveAppRequestTarget(CALLER, ["app:http:@ryu/recipes"], RECIPES)
		).toEqual({ allowed: true, pluginId: RECIPES });
		expect(resolveAppRequestTarget(CALLER, ["app:http"], RECIPES).allowed).toBe(
			false
		);
		expect(
			resolveAppRequestTarget(CALLER, ["app:http:@ryu/recipes"], "@ryu/mail")
				.allowed
		).toBe(false);
	});

	test("the service refuses without the grant and forwards with it", async () => {
		const { calls, forward } = recordingForwarder();
		const allowed = appRequestService({
			approvedGrants: ["app:http:@ryu/recipes"],
			callerId: CALLER,
			forward,
		});
		await allowed({ app: RECIPES, method: "GET", path: "/" });
		expect(calls).toEqual([{ method: "GET", path: "/", pluginId: RECIPES }]);

		const denied = appRequestService({
			approvedGrants: ["app:http"],
			callerId: CALLER,
			forward,
		});
		await expect(
			denied({ app: RECIPES, method: "GET", path: "/" })
		).rejects.toMatchObject({ code: "denied" });
		expect(calls).toHaveLength(1);
	});

	test("the path stays confined to the mount whatever the target", () => {
		for (const path of ["/../mail/x", "/%2e%2e/settings", "//evil.test/x"]) {
			expect(asAppRequestArg({ app: RECIPES, path })).toBeNull();
		}
		expect(asAppRequestArg({ app: "@ryu/*", path: "/" })).toBeNull();
		expect(asAppRequestArg({ app: "https://evil.test", path: "/" })).toBeNull();
		expect(asAppRequestArg({ app: RECIPES, path: "/x?y=1" })).toEqual({
			app: RECIPES,
			method: "GET",
			path: "/x?y=1",
		});
		// No `app`: the own-app shape, unchanged.
		expect(asAppRequestArg({ path: "/status" })).toEqual({
			method: "GET",
			path: "/status",
		});
	});

	test("dispatch: a per-target grant unlocks the verb, the service gates the target", async () => {
		const { calls, forward } = recordingForwarder();
		const grants = ["app:http:@ryu/recipes"];
		const services = hostServices(
			appRequestService({ approvedGrants: grants, callerId: CALLER, forward })
		);
		const granted = capabilitiesFromGrants(grants);
		expect(granted.has("app.http")).toBe(true);
		await dispatchRpc(
			"app.request",
			[{ app: RECIPES, path: "/" }],
			granted,
			services
		);
		await expect(
			dispatchRpc("app.request", [{ path: "/" }], granted, services)
		).rejects.toMatchObject({ code: "denied" });
		await expect(
			dispatchRpc(
				"app.request",
				[{ app: RECIPES, path: "/" }],
				new Set(),
				services
			)
		).rejects.toMatchObject({ code: "denied" });
		expect(calls).toEqual([{ method: "GET", path: "/", pluginId: RECIPES }]);
		// A malformed per-target grant unlocks nothing.
		expect(capabilitiesFromGrants(["app:http:*"]).has("app.http")).toBe(false);
	});

	test("legacy ghost.recipes is served from the Recipes list route", async () => {
		const calls: string[] = [];
		const { ghostRecipes } = ghostRecipesViaAppMount(
			async (pluginId, input) => {
				calls.push(`${pluginId} ${input.method} ${input.path}`);
				return {
					recipes: [
						{
							app: null,
							description: "d",
							name: "r",
							params: [],
							step_count: 1,
						},
					],
				};
			}
		);
		const recipes = await ghostRecipes?.();
		expect(recipes?.map((r) => r.name)).toEqual(["r"]);
		expect(calls).toEqual([`${RECIPES} GET /`]);
	});
});
