import { describe, expect, it } from "bun:test";
import {
	appBundleIdPrefix,
	callerSegment,
	checkAppBundle,
} from "./app-bundle.ts";
import {
	type Capability,
	dispatchRpc,
	type HostServices,
	type RouteClaim,
} from "./rpc.ts";

const CALLER = "@ryu/app-studio";

function bundle(overrides: Record<string, unknown> = {}) {
	return {
		id: "com.local.app-studio.habit-tracker",
		name: "Habit Tracker",
		version: "1.0.0",
		description: "Track daily habits.",
		permission_grants: ["storage:kv"],
		runnables: [
			{
				id: "app-studio-habit-tracker",
				name: "Habit Tracker",
				kind: "companion",
				config: {
					label: "Habit Tracker",
					ui_entry: "./dist/index.html",
					ui_format: "html",
				},
			},
		],
		companion: { label: "Habit Tracker", icon: "apps" },
		ui_code: "<!doctype html><html><body><h1>Habits</h1></body></html>",
		...overrides,
	};
}

describe("callerSegment", () => {
	it("takes the last id segment", () => {
		expect(callerSegment("@ryu/app-studio")).toBe("app-studio");
		expect(callerSegment("com.example.builder")).toBe("builder");
	});

	it("refuses a segment that is not a slug", () => {
		expect(callerSegment("@ryu/")).toBeNull();
		expect(callerSegment("@ryu/App_Studio")).toBeNull();
		expect(appBundleIdPrefix("@ryu/")).toBeNull();
	});
});

describe("checkAppBundle", () => {
	it("accepts a companion-only bundle in the caller's namespace", () => {
		const result = checkAppBundle(CALLER, bundle());
		expect(result.ok).toBe(true);
	});

	it("accepts an update flag for the same namespace", () => {
		const result = checkAppBundle(CALLER, bundle({ update: true }));
		expect(result.ok && result.bundle.update).toBe(true);
	});

	it("refuses an id outside the caller's namespace", () => {
		for (const id of [
			"@ryu/sites",
			"com.local.sites.site-1",
			"com.local.app-studio.",
			"com.local.app-studio.Bad_Name",
			"com.local.app-studio.a.b",
		]) {
			const result = checkAppBundle(CALLER, bundle({ id }));
			expect(result.ok).toBe(false);
		}
	});

	it("refuses process, network, and hook surfaces", () => {
		for (const extra of [
			{ sidecars: [] },
			{ backend_code: "export default 1" },
			{ mcp_servers: {} },
			{ hooks: [] },
			{ contributes: {} },
		]) {
			const result = checkAppBundle(CALLER, bundle(extra));
			expect(result.ok).toBe(false);
		}
	});

	it("refuses grants outside the reviewed companion set", () => {
		for (const grant of ["plugins:install", "sidecar:process", "app:http"]) {
			const result = checkAppBundle(
				CALLER,
				bundle({ permission_grants: [grant] })
			);
			expect(result.ok).toBe(false);
		}
	});

	it("refuses a non-companion runnable or a non-HTML UI", () => {
		const [runnable] = bundle().runnables;
		expect(
			checkAppBundle(
				CALLER,
				bundle({ runnables: [{ ...runnable, kind: "process" }] })
			).ok
		).toBe(false);
		expect(checkAppBundle(CALLER, bundle({ ui_code: "alert(1)" })).ok).toBe(
			false
		);
		expect(checkAppBundle(CALLER, bundle({ version: "1.0" })).ok).toBe(false);
	});

	it("requires the namespaced runnable id", () => {
		const [runnable] = bundle().runnables;
		const result = checkAppBundle(
			CALLER,
			bundle({ runnables: [{ ...runnable, id: "sites-companion" }] })
		);
		expect(result.ok).toBe(false);
	});

	it("refuses labels that impersonate system chrome", () => {
		expect(checkAppBundle(CALLER, bundle({ name: "Ryu Settings" })).ok).toBe(
			false
		);
		expect(
			checkAppBundle(CALLER, bundle({ companion: { label: "System" } })).ok
		).toBe(false);
	});

	it("reports where the bundle is invalid", () => {
		const result = checkAppBundle(CALLER, bundle({ name: "" }));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("name");
		}
	});
});

/** The two host services every RPC host must provide, plus the ones a test exercises. */
function hostServices(extra: Partial<HostServices> = {}): HostServices {
	return {
		listAgents: () => Promise.resolve([]),
		registerRoute: (claim: RouteClaim) => Promise.resolve({ path: claim.path }),
		...extra,
	};
}

describe("apps.installBundle dispatch", () => {
	const granted = new Set<Capability>(["plugins.install"]);

	it("requires the plugins.install capability", async () => {
		await expect(
			dispatchRpc("apps.installBundle", [bundle()], new Set(), hostServices())
		).rejects.toThrow();
	});

	it("reports a host without the installer", async () => {
		await expect(
			dispatchRpc("apps.installBundle", [bundle()], granted, hostServices())
		).rejects.toThrow("apps.installBundle is not available");
	});

	it("passes the bundle to the host and returns its result", async () => {
		let received: unknown;
		const result = await dispatchRpc(
			"apps.installBundle",
			[bundle()],
			granted,
			hostServices({
				appsInstallBundle: async (value) => {
					received = value;
					return {
						id: "com.local.app-studio.habit-tracker",
						installed: true,
						updated: false,
						version: "1.0.0",
					};
				},
			})
		);
		expect(received).toEqual(bundle());
		expect(result).toEqual({
			id: "com.local.app-studio.habit-tracker",
			installed: true,
			updated: false,
			version: "1.0.0",
		});
	});

	it("refuses a call without exactly one bundle", async () => {
		await expect(
			dispatchRpc(
				"apps.installBundle",
				[],
				granted,
				hostServices({
					appsInstallBundle: async () => {
						throw new Error("unreachable");
					},
				})
			)
		).rejects.toThrow("requires one app bundle");
	});
});
