import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { z } from "zod";
import type { ApiTarget } from "@/src/lib/api/client.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const target: ApiTarget = {
	url: "https://safe.fixture",
	token: "node-token",
	userJwt: null,
};
const events: string[] = [];
const authorizations: (string | null)[] = [];
let deferStatus: Promise<string> | null = null;
let deferHealth: {
	target: ApiTarget;
	promise: Promise<Response>;
	skip: number;
} | null = null;
let healthVersion = "9.9.2";
const healthFanouts: string[] = [];
let sentinel = false;
let enabled = false;
let preference = false;
let deferRead: Promise<Response> | null = null;
let deferWrite: Promise<Response> | null = null;
const requests: {
	url: string;
	method: string;
	jwt: string | null;
	token: string | null;
}[] = [];
let forced = false;
let offline = false;
let rejectWrite = false;
let rejectRestart = false;
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
mock.module("@/lib/tauri-bridge.ts", () => ({
	getLocalNodeToken: async () => ({ source: "test", token: null }),
	getRyuStatus: async () => (deferStatus ? await deferStatus : "stopped"),
	startRyuCore: async () => {
		events.push("start");
	},
	restartRyuCore: async () => {
		events.push("restart");
		if (rejectRestart) {
			throw new Error("Restart failed");
		}
		enabled = preference || sentinel;
	},
}));
const nativeBoundary = await import("@/src/lib/tauri-ready.ts");
mock.module("@/src/lib/tauri-ready.ts", () => ({
	...nativeBoundary,
	invokeWhenReady: async (command: string, args?: { enabled: boolean }) => {
		if (command === "get_safe_mode_sentinel") {
			events.push("read-sentinel");
			return sentinel;
		}
		if (command === "set_safe_mode_sentinel") {
			events.push(`sentinel:${args?.enabled}`);
			sentinel = args?.enabled ?? false;
			return;
		}
		throw new Error(`Unexpected native command: ${command}`);
	},
}));
const nodeStore = await import("@/src/store/useNodeStore.ts");
const { LOCAL_FALLBACK } = nodeStore;
const useNodeStoreFixture = Object.assign(
	<T,>(select: (store: { getActiveNode: () => typeof target }) => T) =>
		select({ getActiveNode: () => target }),
	{ getState: () => ({ getActiveNode: () => target }) }
);
mock.module("@/src/store/useNodeStore.ts", () => ({
	...nodeStore,
	useNodeStore: useNodeStoreFixture,
}));
mock.module("@/src/hooks/useEngines.ts", () => ({
	useEngines: () => ({ engines: [] }),
}));
mock.module("@/src/components/updater/AutoUpdater.tsx", () => ({
	applyReleaseUpdate: async () => {},
	scheduleReleaseUpdate: async () => {},
}));
const { PreflightPage } = await import("@/src/pages/PreflightPage.tsx");
const { SafeModeBanner } = await import("../shell/SafeModeBanner.tsx");
const { createRoot } = await import("react-dom/client");
const { SafeModeSettings } = await import("./SafeModeSettings.tsx");
const realFetch = globalThis.fetch;
const roots: Root[] = [];
beforeEach(() => {
	events.length = 0;
	authorizations.length = 0;
	target.url = "https://safe.fixture";
	target.token = "node-token";
	target.userJwt = null;
	requests.length = 0;
	deferRead = deferWrite = null;
	deferStatus = null;
	deferHealth = null;
	healthVersion = "9.9.2";
	healthFanouts.length = 0;
	preference = false;
	sentinel = enabled = forced = offline = rejectWrite = rejectRestart = false;
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(input)).pathname;
			if (path === "/control") {
				return Response.json({});
			}
			if (path === "/api/health") {
				if (
					deferHealth &&
					String(input).startsWith(deferHealth.target.url) &&
					new Headers(init?.headers).get("authorization") === null &&
					--deferHealth.skip < 0
				) {
					const pending = deferHealth.promise;
					deferHealth = null;
					return pending;
				}
				return Response.json({
					status: "ok",
					version: healthVersion,
					capabilities: [],
				});
			}
			if (path === "/api/system/status") {
				healthFanouts.push(String(input));
				return Response.json({ sidecars: {}, gateway: { reachable: false } });
			}
			if (path === "/api/update/check") {
				return Response.json({
					current: "1.0.0",
					latest: "1.0.0",
					update_available: false,
					asset: null,
					channel: "stable",
					html_url: null,
					notes: null,
				});
			}
			if (path !== "/api/safe-mode") {
				throw new Error(`Unexpected API request: ${input}`);
			}
			const method = init?.method ?? "GET";
			requests.push({
				url: String(input),
				method,
				jwt: new Headers(init?.headers).get("x-ryu-user-jwt"),
				token: new Headers(init?.headers).get("authorization"),
			});
			if (method === "GET" && deferRead) {
				return deferRead;
			}
			if (method === "PUT" && deferWrite) {
				return deferWrite;
			}
			if (offline) {
				throw new TypeError("Connection refused");
			}
			if (init?.method === "PUT") {
				authorizations.push(new Headers(init.headers).get("authorization"));
				if (rejectWrite) {
					return Response.json(
						{ error: "Safe Mode is forced on" },
						{ status: 409 }
					);
				}
				const body = z
					.object({ enabled: z.boolean() })
					.parse(JSON.parse(String(init.body)));
				events.push(`core:${body.enabled}`);
				preference = body.enabled;
				if (target.url === LOCAL_FALLBACK.url) {
					sentinel = body.enabled;
				}
				return Response.json({ restart_required: true });
			}
			return Response.json({
				enabled,
				preference_enabled: preference,
				source: forced ? "env" : enabled ? "preference" : "off",
				user_clearable: !forced,
				suppressed: {
					plugins: 3,
					skills: 12,
					mcp_servers: 2,
					kernel_plugins: 4,
				},
			});
		},
		{ preconnect: realFetch.preconnect }
	);
});
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	globalThis.fetch = realFetch;
});
async function flush() {
	await act(async () => {
		await Bun.sleep(20);
	});
}
async function mount(banner = false, preflight = false) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () =>
		root.render(
			preflight ? (
				<PreflightPage />
			) : banner ? (
				<SafeModeBanner />
			) : (
				<SafeModeSettings />
			)
		)
	);
	await flush();
	return root;
}
function switchControl(): HTMLElement {
	const element = document.querySelector<HTMLElement>('[role="switch"]');
	if (!element) {
		throw new Error("Safe Mode switch missing");
	}
	return element;
}
async function toggle() {
	await act(async () => switchControl().click());
	await flush();
}

test("local arming and leaving Safe Mode persist through Core before restarting and render effective state", async () => {
	target.url = LOCAL_FALLBACK.url;
	await mount();
	expect(switchControl().getAttribute("aria-checked")).toBe("false");
	expect(document.body.textContent).toContain(
		"3 apps, 12 skills and 2 MCP servers"
	);
	expect(document.body.textContent).toContain(
		"each thread's next message after the restart is sent without the prompt cache"
	);
	await toggle();
	expect(events).toEqual([
		"read-sentinel",
		"core:true",
		"restart",
		"read-sentinel",
	]);
	expect(switchControl().getAttribute("aria-checked")).toBe("true");
	const leave = [...document.querySelectorAll("button")].find(
		(button) => button.textContent === "Leave Safe Mode"
	);
	expect(leave).toBeDefined();
	await act(async () => leave?.click());
	await flush();
	expect(events).toEqual([
		"read-sentinel",
		"core:true",
		"restart",
		"read-sentinel",
		"core:false",
		"restart",
		"read-sentinel",
	]);
	expect(authorizations).toEqual(["Bearer node-token", "Bearer node-token"]);
	expect(switchControl().getAttribute("aria-checked")).toBe("false");
});
test("an environment-forced node disables clearing even when the persisted preference is off", async () => {
	enabled = forced = true;
	await mount();
	expect(switchControl().getAttribute("aria-checked")).toBe("true");
	expect(switchControl().getAttribute("aria-disabled")).toBe("true");
	expect(document.body.textContent).toContain("forced on by the RYU_SAFE_MODE");
	expect(document.body.textContent).not.toContain("Leave Safe Mode");
	await toggle();
	expect(events).toEqual([]);
});
test("Core refusing a write cannot fall back to a sentinel or restart; retry succeeds", async () => {
	rejectWrite = true;
	await mount();
	await toggle();
	expect(events).toEqual([]);
	expect(switchControl().getAttribute("aria-checked")).toBe("false");
	expect(switchControl().getAttribute("aria-disabled")).not.toBe("true");
	rejectWrite = false;
	await toggle();
	expect(events).toEqual(["core:true"]);
	expect(document.body.textContent).toContain("Restart the remote node");
	expect(switchControl().getAttribute("aria-checked")).toBe("true");
});
test("offline recovery arms the on-disk sentinel before restart and retains it when restart fails", async () => {
	target.url = LOCAL_FALLBACK.url;
	offline = rejectRestart = true;
	await mount();
	expect(document.body.textContent).toContain("The node isn't answering");
	await toggle();
	expect(events).toEqual([
		"read-sentinel",
		"sentinel:true",
		"restart",
		"read-sentinel",
	]);
	expect(sentinel).toBe(true);
	expect(switchControl().getAttribute("aria-checked")).toBe("true");
	expect(switchControl().getAttribute("aria-disabled")).not.toBe("true");
});

function deferred() {
	let resolve!: (value: Response) => void;
	const promise = new Promise<Response>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function stateResponse(on: boolean) {
	return Response.json({
		enabled: on,
		preference_enabled: on,
		user_clearable: true,
		source: on ? "preference" : "off",
		suppressed: { plugins: 91, skills: 0, mcp_servers: 0 },
	});
}
async function rerender(root: Root, banner: boolean) {
	await act(async () =>
		root.render(banner ? <SafeModeBanner /> : <SafeModeSettings />)
	);
	await flush();
}
test("remote transport failure never reads or writes the desktop sentinel; state is retained and retry saves only remotely", async () => {
	sentinel = true;
	await mount();
	expect(events).toEqual([]);
	expect(switchControl().getAttribute("aria-checked")).toBe("false");
	offline = true;
	await toggle();
	expect(events).toEqual([]);
	expect(switchControl().getAttribute("aria-checked")).toBe("false");
	offline = false;
	await toggle();
	expect(events).toEqual(["core:true"]);
	expect(sentinel).toBe(true);
	expect(enabled).toBe(false);
	expect(document.body.textContent).toContain("Saved for this node");
});
test("an unreachable remote does not display the local sentinel as its state", async () => {
	sentinel = offline = true;
	await mount();
	expect(events).toEqual([]);
	expect(switchControl().getAttribute("aria-checked")).toBe("false");
	expect(document.body.textContent).toContain("remote node is not answering");
});
for (const banner of [false, true]) {
	for (const authority of ["url", "token", "userJwt"] as const) {
		test(`${banner ? "banner" : "settings"} rejects stale GET after ${authority} authority changes`, async () => {
			const read = deferred();
			deferRead = read.promise;
			const root = await mount(banner);
			deferRead = null;
			target[authority] =
				authority === "url"
					? "https://other.fixture"
					: "replacement-credential";
			await rerender(root, banner);
			read.resolve(stateResponse(true));
			await flush();
			expect(document.body.textContent).not.toContain("91 app");
			if (banner) {
				expect(document.body.textContent).not.toContain("Safe Mode");
			} else {
				expect(switchControl().getAttribute("aria-checked")).toBe("false");
			}
			const latest = requests.at(-1);
			expect(latest?.url).toContain(target.url);
			expect(latest?.token).toBe(`Bearer ${target.token}`);
			expect(latest?.jwt).toBe(target.userJwt);
			expect(events).toEqual([]);
		});
	}
	test(`${banner ? "banner" : "settings"} late local PUT failure after switching nodes cannot fall back or restart`, async () => {
		target.url = LOCAL_FALLBACK.url;
		enabled = preference = banner;
		const root = await mount(banner);
		let reject!: (reason: Error) => void;
		deferWrite = new Promise((_resolve, fail) => {
			reject = fail;
		});
		await act(async () => {
			if (banner) {
				document.querySelector<HTMLButtonElement>("button")?.click();
			} else {
				switchControl().click();
			}
		});
		target.url = "https://new.fixture";
		enabled = preference = false;
		deferWrite = null;
		await rerender(root, banner);
		reject(new TypeError("Old local connection failed"));
		await flush();
		expect(events).toEqual(["read-sentinel"]);
		expect(sentinel).toBe(false);
		if (!banner) {
			expect(switchControl().getAttribute("aria-disabled")).not.toBe("true");
		}
	});
	for (const authority of ["url", "token", "userJwt"] as const) {
		test(`${banner ? "banner" : "settings"} ignores late PUT success after ${authority} rotation`, async () => {
			enabled = preference = banner;
			const root = await mount(banner);
			const write = deferred();
			deferWrite = write.promise;
			await act(async () => {
				if (banner) {
					document.querySelector<HTMLButtonElement>("button")?.click();
				} else {
					switchControl().click();
				}
			});
			target[authority] =
				authority === "url" ? "https://new.fixture" : "new-credential";
			deferWrite = null;
			await rerender(root, banner);
			write.resolve(Response.json({ restart_required: true }));
			await flush();
			expect(events).toEqual([]);
			expect(document.body.textContent).not.toContain("Saved");
		});
	}
}
test("remote banner exit saves remotely, keeps effective warning until restart, and never restarts desktop Core", async () => {
	enabled = preference = true;
	await mount(true);
	await act(async () =>
		document.querySelector<HTMLButtonElement>("button")?.click()
	);
	await flush();
	expect(events).toEqual(["core:false"]);
	expect(enabled).toBe(true);
	expect(preference).toBe(false);
	expect(document.body.textContent).toContain(
		"Restart the remote node to leave Safe Mode"
	);
	expect(document.querySelector<HTMLButtonElement>("button")?.disabled).toBe(
		true
	);
});

for (const failure of ["transport", "refused"] as const) {
	test(`remote banner retains effective state after ${failure} failure and allows a real retry`, async () => {
		enabled = preference = true;
		await mount(true);
		offline = failure === "transport";
		rejectWrite = failure === "refused";
		await act(async () =>
			document.querySelector<HTMLButtonElement>("button")?.click()
		);
		await flush();
		expect(events).toEqual([]);
		expect(enabled).toBe(true);
		expect(preference).toBe(true);
		expect(document.body.textContent).toContain("3 apps");
		expect(document.querySelector<HTMLButtonElement>("button")?.disabled).toBe(
			false
		);
		offline = rejectWrite = false;
		await act(async () =>
			document.querySelector<HTMLButtonElement>("button")?.click()
		);
		await flush();
		expect(events).toEqual(["core:false"]);
		expect(document.body.textContent).toContain("Restart the remote node");
	});
}
test("banner readback of a previously saved remote exit remains pending after remount", async () => {
	enabled = true;
	preference = false;
	await mount(true);
	expect(document.body.textContent).toContain(
		"Restart the remote node to leave Safe Mode"
	);
	expect(document.querySelector<HTMLButtonElement>("button")?.disabled).toBe(
		true
	);
	expect(events).toEqual([]);
});

function preflightSafeAction() {
	const button = [...document.querySelectorAll("button")].find((button) =>
		/Safe Mode/.test(button.textContent ?? "")
	);
	if (!button) {
		throw new Error("Preflight Safe Mode action missing");
	}
	return button;
}
test("remote preflight save and clear change only remote next-boot preferences", async () => {
	sentinel = true;
	await mount(false, true);
	expect(events).toEqual([]);
	expect(preflightSafeAction().textContent).toContain(
		"Save Safe Mode for next boot"
	);
	await act(async () => preflightSafeAction().click());
	await flush();
	expect(events).toEqual(["core:true"]);
	expect(enabled).toBe(false);
	expect(document.body.textContent).toContain(
		"Restart the remote node to apply"
	);
	await act(async () => preflightSafeAction().click());
	await flush();
	expect(events).toEqual(["core:true", "core:false"]);
	expect(sentinel).toBe(true);
});
test("remote preflight transport error retains choice without local recovery and permits retry", async () => {
	await mount(false, true);
	offline = true;
	await act(async () => preflightSafeAction().click());
	await flush();
	expect(events).toEqual([]);
	expect(preflightSafeAction().textContent).toContain(
		"Save Safe Mode for next boot"
	);
	offline = false;
	await act(async () => preflightSafeAction().click());
	await flush();
	expect(events).toEqual(["core:true"]);
});
test("local preflight still arms the recovery sentinel while local Core is unavailable", async () => {
	target.url = LOCAL_FALLBACK.url;
	offline = true;
	await mount(false, true);
	expect(events).toEqual(["read-sentinel", "start"]);
	await act(async () => preflightSafeAction().click());
	await flush();
	expect(events).toEqual([
		"read-sentinel",
		"start",
		"sentinel:true",
		"restart",
		"read-sentinel",
	]);
	expect(sentinel).toBe(true);
});

for (const authority of ["url", "token", "userJwt"] as const) {
	test(`preflight rejects late GET after ${authority} authority switch`, async () => {
		const read = deferred();
		deferRead = read.promise;
		const root = await mount(false, true);
		deferRead = null;
		target[authority] =
			authority === "url" ? "https://new.fixture" : "new-credential";
		await act(async () => root.render(<PreflightPage />));
		await flush();
		read.resolve(stateResponse(true));
		await flush();
		expect(preflightSafeAction().textContent).toContain(
			"Save Safe Mode for next boot"
		);
		expect(events).toEqual([]);
		expect(requests.at(-1)?.url).toContain(target.url);
		expect(requests.at(-1)?.token).toBe(`Bearer ${target.token}`);
		expect(requests.at(-1)?.jwt).toBe(target.userJwt);
	});
	test(`preflight rejects late PUT success after ${authority} authority switch`, async () => {
		const root = await mount(false, true);
		const write = deferred();
		deferWrite = write.promise;
		await act(async () => preflightSafeAction().click());
		target[authority] =
			authority === "url" ? "https://new.fixture" : "new-credential";
		deferWrite = null;
		await act(async () => root.render(<PreflightPage />));
		await flush();
		write.resolve(Response.json({ restart_required: true }));
		await flush();
		expect(events).toEqual([]);
		expect(preflightSafeAction().textContent).toContain(
			"Save Safe Mode for next boot"
		);
		expect(document.body.textContent).not.toContain("Saved for this node");
	});
}
test("preflight switching away from a local pending write suppresses native fallback and restart", async () => {
	target.url = LOCAL_FALLBACK.url;
	const root = await mount(false, true);
	let reject!: (reason: Error) => void;
	deferWrite = new Promise((_resolve, fail) => {
		reject = fail;
	});
	await act(async () => preflightSafeAction().click());
	target.url = "https://remote.fixture";
	deferWrite = null;
	await act(async () => root.render(<PreflightPage />));
	await flush();
	reject(new TypeError("Old node disconnected"));
	await flush();
	expect(events).toEqual(["read-sentinel", "start"]);
	expect(sentinel).toBe(false);
	expect(preflightSafeAction().textContent).toContain(
		"Save Safe Mode for next boot"
	);
});

test("preflight cannot offer clearing an environment-forced node", async () => {
	enabled = forced = true;
	await mount(false, true);
	expect(
		[...document.querySelectorAll("button")].some((button) =>
			/Safe Mode/.test(button.textContent ?? "")
		)
	).toBe(false);
	expect(document.body.textContent).toContain(
		"Remove its RYU_SAFE_MODE override"
	);
	expect(events).toEqual([]);
});

test("preflight ignores late stopped native status after switching local to remote", async () => {
	target.url = LOCAL_FALLBACK.url;
	let resolve!: (value: string) => void;
	deferStatus = new Promise((done) => {
		resolve = done;
	});
	const root = await mount(false, true);
	target.url = "https://remote.fixture";
	await act(async () => root.render(<PreflightPage />));
	await flush();
	resolve("stopped");
	await flush();
	expect(events).toEqual(["read-sentinel"]);
	expect(document.body.textContent).toContain("9.9.2");
	expect(
		[...document.querySelectorAll("button")].some(
			(button) =>
				button.textContent === "Start Core" ||
				button.textContent === "Restart Core"
		)
	).toBe(false);
});
for (const authority of ["url", "token", "userJwt"] as const) {
	test(`preflight old remote health fanout cannot replace live version after ${authority} rotation`, async () => {
		const health = deferred();
		deferHealth = { target: { ...target }, promise: health.promise, skip: 1 };
		const root = await mount(false, true);
		target[authority] =
			authority === "url" ? "https://new.fixture" : "new-credential";
		await act(async () => root.render(<PreflightPage />));
		await flush();
		expect(document.body.textContent).toContain("9.9.2");
		health.resolve(
			Response.json({ status: "ok", version: "1.1.1", capabilities: [] })
		);
		await flush();
		expect(document.body.textContent).toContain("9.9.2");
		expect(document.body.textContent).not.toContain("1.1.1");
		expect(events).toEqual([]);
	});
}
for (const banner of [false, true]) {
	test(`${banner ? "banner" : "settings"} serializes two real clicks in the same turn`, async () => {
		enabled = preference = banner;
		await mount(banner);
		const write = deferred();
		deferWrite = write.promise;
		const button = banner
			? document.querySelector<HTMLButtonElement>("button")
			: switchControl();
		if (!button) {
			throw new Error("Missing Safe Mode action");
		}
		await act(async () => {
			button.click();
			button.click();
		});
		await flush();
		expect(requests.filter((request) => request.method === "PUT")).toHaveLength(
			1
		);
		write.resolve(Response.json({ restart_required: true }));
		await flush();
		expect(events).toEqual([]);
	});
}

test("preflight unmount prevents late native status from automatically starting Core", async () => {
	target.url = LOCAL_FALLBACK.url;
	let resolve!: (value: string) => void;
	deferStatus = new Promise((done) => {
		resolve = done;
	});
	const root = await mount(false, true);
	await act(async () => root.unmount());
	roots.splice(roots.indexOf(root), 1);
	resolve("stopped");
	await flush();
	expect(events).toEqual(["read-sentinel"]);
});

test("preflight retains one slow health fanout across poll ticks, publishes it, and resumes polling", async () => {
	const health = deferred();
	deferHealth = { target: { ...target }, promise: health.promise, skip: 1 };
	await mount(false, true);
	await act(async () => {
		await Bun.sleep(5200);
	});
	expect(healthFanouts).toHaveLength(1);
	health.resolve(
		Response.json({ status: "ok", version: "9.9.2", capabilities: [] })
	);
	await flush();
	expect(document.body.textContent).toContain("9.9.2");
	await act(async () => {
		await Bun.sleep(2500);
	});
	expect(healthFanouts.length).toBeGreaterThan(1);
	expect(healthFanouts.every((url) => url.startsWith(target.url))).toBe(true);
	expect(document.body.textContent).toContain("9.9.2");
}, 12_000);
