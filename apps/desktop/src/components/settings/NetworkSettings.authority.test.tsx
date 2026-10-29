import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const NativeResponse = globalThis.Response,
	nativeFetch = globalThis.fetch;
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Object.assign(globalThis, { Response: NativeResponse, fetch: nativeFetch });
mock.module("@/src/hooks/useFeatureFlag.ts", () => ({
	useFeatureFlag: () => true,
}));
mock.module("@/src/components/billing/OrgBillingContext.tsx", () => ({
	OrgBillingContext: () => null,
}));
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useNodeStore, LOCAL_FALLBACK } = await import(
	"@/src/store/useNodeStore.ts"
);
const { sileo } = await import("sileo");
const { NetworkSettings, ManagedInferenceSettings } = await import(
	"./NetworkSettings.tsx"
);
type Authority = { url: string; token: string; userJwt: string | null };
type Call = {
	scope: string;
	path: string;
	method: string;
	token: string | null;
	jwt: string | null;
	body: unknown;
};
type State = {
	prefs: Record<string, string>;
	enabled: boolean;
	installing?: boolean;
	reachable?: boolean;
};
let server: ReturnType<typeof Bun.serve>,
	root: ReturnType<typeof createRoot>,
	container: HTMLDivElement;
let states: Record<string, State>,
	calls: Call[],
	holds: Set<string>,
	releases: Map<string, Array<() => void>>,
	fail: Set<string>,
	refusalStatuses: Map<string, number>,
	unknown: string[];
let success: ReturnType<typeof spyOn<typeof sileo, "success">>,
	error: ReturnType<typeof spyOn<typeof sileo, "error">>;
const signature = (a: Authority) =>
	`${new URL(a.url).pathname}|${a.token}|${a.userJwt ?? ""}`;
let a: Authority, b: Authority;
function rawStatus(state: State) {
	return {
		enabled: state.enabled,
		reachable: state.reachable ?? false,
		backend: "headscale",
		backend_state: "Stopped",
		control_server: null,
		magic_dns_name: null,
		tailscale_ips: [],
		peers: [],
	};
}
async function idle() {
	for (let i = 0; i < 8; i++)
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
}
async function select(authority: Authority) {
	await act(async () => {
		useNodeStore.setState({
			defaultNode: "owned-network",
			nodes: [{ ...LOCAL_FALLBACK, name: "owned-network", ...authority }],
		});
	});
	await idle();
}
function seed(authority: Authority, label: string) {
	states[signature(authority)] = {
		prefs: {
			"managed-gateway-url": `https://fleet-${label}.example.test`,
			"managed-gateway-token": `rgw_${label}`,
			"mesh-login-server": `https://headscale-${label}.example.test`,
			"mesh-backend": "headscale",
		},
		enabled: false,
	};
}
async function mount(kind: "managed" | "mesh") {
	await act(async () =>
		root.render(
			createElement(
				kind === "managed" ? ManagedInferenceSettings : NetworkSettings,
			),
		),
	);
	await idle();
}
function input(label: string) {
	const node = container.querySelector<HTMLInputElement>(
		`input[aria-label="${label}"]`,
	);
	if (!node) throw new Error(`Actual control absent ${label}`);
	return node;
}
async function fill(label: string, value: string) {
	await act(async () => {
		const node = input(label);
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		setter!.call(node, value);
		node.dispatchEvent(new Event("input", { bubbles: true }));
		node.dispatchEvent(new Event("change", { bubbles: true }));
	});
}
async function clickSave() {
	const button = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].find((button) => button.textContent?.trim() === "Save");
	if (!button) throw new Error("Actual Save absent");
	await act(async () => button.click());
	await idle();
}
async function toggle() {
	const button = container.querySelector<HTMLElement>('[role="switch"]');
	if (!button) throw new Error("Actual mesh switch absent");
	await act(async () => button.click());
	await idle();
}
function release(key: string) {
	holds.delete(key);
	for (const done of releases.get(key) ?? []) done();
	releases.delete(key);
}
beforeEach(async () => {
	states = {};
	calls = [];
	holds = new Set();
	releases = new Map();
	fail = new Set();
	refusalStatuses = new Map();
	unknown = [];
	success = spyOn(sileo, "success").mockImplementation(() => "owned-success");
	error = spyOn(sileo, "error").mockImplementation(() => "owned-error");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const path = url.pathname.replace(/^\/(a|b)/, "");
			const prefix = url.pathname.startsWith("/b/") ? "/b" : "/a";
			const token =
				request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
			const jwt = request.headers.get("x-ryu-user-jwt");
			const scope = `${prefix}|${token}|${jwt ?? ""}`;
			const state = states[scope];
			const body = request.method === "GET" ? null : await request.json();
			calls.push({
				scope,
				path,
				method: request.method,
				token: request.headers.get("authorization"),
				jwt,
				body,
			});
			if (!state) {
				unknown.push(scope);
				return NativeResponse.json(
					{ error: "Wrong authority" },
					{ status: 403 },
				);
			}
			const key = `${scope}:${request.method}:${path}`;
			const snapshot = structuredClone(state);
			if (holds.has(key))
				await new Promise<void>((resolve) => {
					releases.set(key, [...(releases.get(key) ?? []), resolve]);
				});
			if (fail.delete(key))
				return NativeResponse.json(
					{ error: "Owned network write refused" },
					{ status: refusalStatuses.get(key) ?? 503 },
				);
			if (path.startsWith("/api/preferences/")) {
				const pref = decodeURIComponent(path.slice("/api/preferences/".length));
				if (
					![
						"managed-gateway-url",
						"managed-gateway-token",
						"mesh-login-server",
						"mesh-backend",
					].includes(pref)
				) {
					unknown.push(path);
					return NativeResponse.json(
						{ error: "Unknown preference" },
						{ status: 503 },
					);
				}
				if (request.method === "GET" && !Object.hasOwn(state.prefs, pref))
					return NativeResponse.json(
						{ error: "preference_not_set" },
						{ status: 404 },
					);
				if (request.method === "GET")
					return NativeResponse.json({
						key: pref,
						value: snapshot.prefs[pref],
					});
				if (
					request.method === "PUT" &&
					body &&
					Object.keys(body).length === 1 &&
					typeof body.value === "string"
				) {
					state.prefs[pref] = body.value;
					return NativeResponse.json({ key: pref, value: body.value });
				}
			}
			if (path === "/api/setup/status/tailscale" && request.method === "GET")
				return NativeResponse.json({ status: { state: "installed" } });
			if (path === "/api/mesh/status" && request.method === "GET")
				return NativeResponse.json(rawStatus(snapshot));
			if (
				path === "/api/mesh/config" &&
				request.method === "POST" &&
				body &&
				Object.keys(body).length === 1 &&
				typeof body.enabled === "boolean"
			) {
				state.enabled = body.enabled;
				return NativeResponse.json({
					...rawStatus(state),
					installing: state.installing ?? false,
					start_error: null,
				});
			}
			unknown.push(`${request.method} ${path}`);
			return NativeResponse.json(
				{ error: "Unexpected contract" },
				{ status: 503 },
			);
		},
	});
	const base = server.url.toString().replace(/\/$/, "");
	a = { url: base + "/a", token: "owner-a", userJwt: "jwt-a" };
	b = { url: base + "/b", token: "owner-b", userJwt: "jwt-b" };
	seed(a, "a");
	seed(b, "b");
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await select(a);
});
afterEach(async () => {
	await act(async () => root.unmount());
	for (const key of new Set([...holds, ...releases.keys()])) release(key);
	await idle();
	server.stop(true);
	success.mockRestore();
	error.mockRestore();
	container.remove();
	expect(unknown).toEqual([]);
});
for (const rotation of ["url", "token", "jwt"] as const)
	test(`actual managed controls reload their owned values after ${rotation} authority changes`, async () => {
		if (rotation === "token") b = { ...a, token: "owner-b" };
		if (rotation === "jwt") b = { ...a, userJwt: "jwt-b" };
		if (rotation === "url") b = { ...a, url: b.url };
		seed(b, "b");
		await mount("managed");
		expect(input("Fleet URL").value).toBe("https://fleet-a.example.test");
		await select(b);
		expect(input("Fleet URL").value).toBe("https://fleet-b.example.test");
		expect(input("Organization token").value).toBe("rgw_b");
		await fill("Fleet URL", "https://fleet-edited.example.test");
		await clickSave();
		const writes = calls.filter((c) => c.method === "PUT");
		expect(writes).toHaveLength(2);
		expect(writes.every((c) => c.scope === signature(b))).toBe(true);
		expect(states[signature(a)]!.prefs["managed-gateway-url"]).toBe(
			"https://fleet-a.example.test",
		);
		expect(states[signature(b)]!.prefs["managed-gateway-url"]).toBe(
			"https://fleet-edited.example.test",
		);
	});
test("a late A read cannot overwrite the current managed B controls", async () => {
	for (const key of ["managed-gateway-url", "managed-gateway-token"])
		holds.add(`${signature(a)}:GET:/api/preferences/${key}`);
	await mount("managed");
	await select(b);
	expect(input("Fleet URL").value).toBe("https://fleet-b.example.test");
	for (const key of [...holds]) release(key);
	await idle();
	expect(input("Fleet URL").value).toBe("https://fleet-b.example.test");
	expect(input("Organization token").value).toBe("rgw_b");
});
test("a retired managed save cannot publish its global success into B", async () => {
	await mount("managed");
	for (const pref of ["managed-gateway-url", "managed-gateway-token"])
		holds.add(`${signature(a)}:PUT:/api/preferences/${pref}`);
	await fill("Fleet URL", "https://old-owned-edit.example.test");
	await clickSave();
	await select(b);
	expect(input("Fleet URL").value).toBe("https://fleet-b.example.test");
	for (const key of [...holds]) release(key);
	await idle();
	expect(success.mock.calls).toEqual([]);
	expect(error.mock.calls).toEqual([]);
	expect(input("Organization token").value).toBe("rgw_b");
	expect(
		calls
			.filter((c) => c.method === "PUT")
			.every((c) => c.scope === signature(a)),
	).toBe(true);
});
test("managed refusal preserves its draft and retry saves the identical owner payload with remount readback", async () => {
	await mount("managed");
	await fill("Fleet URL", "https://retry-owned.example.test");
	fail.add(`${signature(a)}:PUT:/api/preferences/managed-gateway-token`);
	await clickSave();
	expect(error.mock.calls.at(-1)?.[0].title).toBe("Failed to save");
	expect(input("Fleet URL").value).toBe("https://retry-owned.example.test");
	await clickSave();
	expect(success.mock.calls.at(-1)?.[0].title).toBe(
		"Managed inference connected",
	);
	const writes = calls.filter((c) => c.method === "PUT");
	expect(writes).toHaveLength(4);
	expect(writes.slice(0, 2).map((c) => c.body)).toEqual(
		writes.slice(2).map((c) => c.body),
	);
	await act(async () => root.render(null));
	await mount("managed");
	expect(input("Fleet URL").value).toBe("https://retry-owned.example.test");
	expect(input("Organization token").value).toBe("rgw_a");
});
test("mesh and Headscale read the selected B owner and never submit A's displayed URL", async () => {
	states[signature(a)]!.enabled = true;
	await mount("mesh");
	expect(input("Headscale control server URL").value).toBe(
		"https://headscale-a.example.test",
	);
	await select(b);
	expect(input("Headscale control server URL").value).toBe(
		"https://headscale-b.example.test",
	);
	expect(
		container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
	).toBe("false");
	await toggle();
	expect(calls.filter((c) => c.path === "/api/mesh/config")).toEqual([
		{
			scope: signature(b),
			path: "/api/mesh/config",
			method: "POST",
			token: "Bearer owner-b",
			jwt: "jwt-b",
			body: { enabled: true },
		},
	]);
	await fill(
		"Headscale control server URL",
		"https://headscale-edited.example.test",
	);
	await clickSave();
	expect(states[signature(a)]!.prefs["mesh-login-server"]).toBe(
		"https://headscale-a.example.test",
	);
	expect(states[signature(b)]!.prefs["mesh-login-server"]).toBe(
		"https://headscale-edited.example.test",
	);
});
test("held A mesh completion cannot change B's switch or publish stale success", async () => {
	await mount("mesh");
	const key = `${signature(a)}:POST:/api/mesh/config`;
	holds.add(key);
	await toggle();
	await select(b);
	expect(
		container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
	).toBe("false");
	release(key);
	await idle();
	expect(
		container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
	).toBe("false");
	expect(success.mock.calls).toEqual([]);
});
test("switching nodes then saving without edits never copies A's managed credentials into B", async () => {
	await mount("managed");
	await select(b);
	await clickSave();
	const writes = calls.filter((c) => c.method === "PUT");
	expect(writes).toHaveLength(2);
	expect(
		writes.map((c) => ({ scope: c.scope, path: c.path, body: c.body })),
	).toEqual([
		{
			scope: signature(b),
			path: "/api/preferences/managed-gateway-url",
			body: { value: "https://fleet-b.example.test" },
		},
		{
			scope: signature(b),
			path: "/api/preferences/managed-gateway-token",
			body: { value: "rgw_b" },
		},
	]);
	expect(states[signature(b)]!.prefs["managed-gateway-token"]).toBe("rgw_b");
});
test("retired A refusal cannot publish an error or reset the returning A owner's pending save", async () => {
	await mount("managed");
	const key = `${signature(a)}:PUT:/api/preferences/managed-gateway-token`;
	holds.add(key);
	fail.add(key);
	await fill("Fleet URL", "https://first-a.example.test");
	await clickSave();
	await select(b);
	await select(a);
	// Returning controls may wait for the old acknowledgment; no concurrent new intent is required.
	release(key);
	await idle();
	expect(error.mock.calls).toEqual([]);
	expect(success.mock.calls).toEqual([]);
	expect(input("Organization token").value).toBe("rgw_a");
	holds.add(key);
	await fill("Fleet URL", "https://second-a.example.test");
	await clickSave();
	expect(container.textContent).toContain("Saving…");
	expect(input("Fleet URL").value).toBe("https://second-a.example.test");
	expect(success.mock.calls).toEqual([]);
	release(key);
	await idle();
	expect(success.mock.calls).toHaveLength(1);
	expect(states[signature(a)]!.prefs["managed-gateway-url"]).toBe(
		"https://second-a.example.test",
	);
});
test("a real mesh refusal preserves its switch and identical owner retry is durable after remount", async () => {
	await mount("mesh");
	fail.add(`${signature(a)}:POST:/api/mesh/config`);
	await toggle();
	expect(
		container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
	).toBe("false");
	expect(error.mock.calls.at(-1)?.[0].title).toBe(
		"Failed to enable the tunnel",
	);
	await toggle();
	expect(
		container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
	).toBe("true");
	const writes = calls.filter((c) => c.path === "/api/mesh/config");
	expect(writes).toHaveLength(2);
	expect(writes.every((c) => c.scope === signature(a))).toBe(true);
	expect(writes.map((c) => c.body)).toEqual([
		{ enabled: true },
		{ enabled: true },
	]);
	await act(async () => root.render(null));
	await mount("mesh");
	expect(
		container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
	).toBe("true");
});
test("retired Headscale acknowledgment cannot publish a global success over the selected node", async () => {
	await mount("mesh");
	const key = `${signature(a)}:PUT:/api/preferences/mesh-login-server`;
	holds.add(key);
	await fill("Headscale control server URL", "https://old-edit.example.test");
	await clickSave();
	await select(b);
	expect(input("Headscale control server URL").value).toBe(
		"https://headscale-b.example.test",
	);
	release(key);
	await idle();
	expect(success.mock.calls).toEqual([]);
	expect(error.mock.calls).toEqual([]);
	expect(states[signature(a)]!.prefs["mesh-login-server"]).toBe(
		"https://old-edit.example.test",
	);
	expect(states[signature(b)]!.prefs["mesh-login-server"]).toBe(
		"https://headscale-b.example.test",
	);
});
test("the actual installation watcher stops polling and publishing after its mounted node owner retires", async () => {
	states[signature(a)]!.installing = true;
	await mount("mesh");
	await toggle();
	expect(
		container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
	).toBe("true");
	const readsBefore = calls.filter(
		(c) => c.scope === signature(a) && c.path === "/api/mesh/status",
	).length;
	await select(b);
	states[signature(a)]!.reachable = true;
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 3100));
	});
	await idle();
	expect(
		calls.filter(
			(c) => c.scope === signature(a) && c.path === "/api/mesh/status",
		),
	).toHaveLength(readsBefore);
	expect(success.mock.calls).toEqual([]);
	expect(error.mock.calls).toEqual([]);
	expect(
		container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
	).toBe("false");
}, 8000);
test("a held old installation poll cannot launch the next probe or publish ready after node handoff", async () => {
	states[signature(a)]!.installing = true;
	await mount("mesh");
	const key = `${signature(a)}:GET:/api/mesh/status`;
	holds.add(key);
	states[signature(a)]!.reachable = true;
	await toggle();
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 3100));
	});
	expect(releases.get(key)).toHaveLength(1);
	await select(b);
	release(key);
	await idle();
	expect(
		calls.filter(
			(c) =>
				c.scope === signature(a) && c.path === "/api/setup/status/tailscale",
		),
	).toEqual([]);
	expect(success.mock.calls).toEqual([]);
	expect(error.mock.calls).toEqual([]);
	expect(
		container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
	).toBe("false");
}, 8000);
function saveButton() {
	const button = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].find((button) => button.textContent?.trim() === "Save");
	if (!button) throw new Error("Actual Save absent");
	return button;
}
async function retryRead() {
	const button = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].find((button) => button.textContent?.trim() === "Retry");
	if (!button) throw new Error("Actual read Retry absent");
	await act(async () => button.click());
	await idle();
}
test("node credentials are never exposed as actual React subtree keys", async () => {
	await mount("managed");
	const node = input("Fleet URL");
	const fiberKey = Object.keys(node).find((key) =>
		key.startsWith("__reactFiber$"),
	);
	if (!fiberKey)
		throw new Error("Actual mounted React Fiber was not available");
	let fiber = Reflect.get(node, fiberKey);
	const keys: string[] = [];
	while (fiber) {
		if (fiber.key !== null) keys.push(String(fiber.key));
		fiber = fiber.return;
	}
	expect(keys.length).toBeGreaterThan(0);
	expect(
		keys.some((key) => key.includes(a.token) || key.includes(a.userJwt!)),
	).toBe(false);
});
for (const kind of ["managed", "mesh"] as const)
	test(`returning to A cannot let an acknowledged old200 overwrite a fresh ${kind} save`, async () => {
		await mount(kind);
		const pref =
			kind === "managed" ? "managed-gateway-token" : "mesh-login-server";
		const label =
			kind === "managed"
				? "Organization token"
				: "Headscale control server URL";
		const first =
			kind === "managed" ? "rgw_first_a" : "https://first-a.example.test";
		const second =
			kind === "managed" ? "rgw_second_a" : "https://second-a.example.test";
		const key = `${signature(a)}:PUT:/api/preferences/${pref}`;
		holds.add(key);
		await fill(label, first);
		await clickSave();
		expect(releases.get(key)).toHaveLength(1);
		await select(b);
		await select(a);
		const existingSave = [
			...container.querySelectorAll<HTMLButtonElement>("button"),
		].find((button) => button.textContent?.trim() === "Save");
		const blocked = existingSave === undefined || existingSave.disabled;
		const readsBefore = calls.filter(
			(c) => c.scope === signature(a) && c.method === "GET",
		).length;
		// Exercise the legacy race through its actually-enabled UI; the corrected UI
		// must instead wait before any fresh GET or writable draft, then allow the intent.
		holds.delete(key);
		if (blocked) {
			const loadingInput = container.querySelector<HTMLInputElement>(
				`input[aria-label="${label}"]`,
			);
			expect(loadingInput === null || loadingInput.disabled).toBe(true);
			release(key);
			await idle();
			expect(
				calls.filter((c) => c.scope === signature(a) && c.method === "GET")
					.length,
			).toBeGreaterThan(readsBefore);
			await fill(label, second);
			await clickSave();
		} else {
			await fill(label, second);
			await clickSave();
			expect(states[signature(a)]!.prefs[pref]).toBe(second);
			release(key);
			await idle();
		}
		expect(states[signature(a)]!.prefs[pref]).toBe(second);
		expect(input(label).value).toBe(second);
		expect(blocked).toBe(true);
		expect(states[signature(b)]!.prefs[pref]).toBe(
			kind === "managed" ? "rgw_b" : "https://headscale-b.example.test",
		);
		expect(
			calls
				.filter(
					(c) =>
						c.scope === signature(a) &&
						c.method === "PUT" &&
						c.path.endsWith(pref),
				)
				.map((c) => c.body),
		).toEqual([{ value: first }, { value: second }]);
	});
test("closing and reopening managed controls waits for the shared owner's held write before reading editable values", async () => {
	await mount("managed");
	const key = `${signature(a)}:PUT:/api/preferences/managed-gateway-token`;
	holds.add(key);
	await fill("Organization token", "rgw_reopened_a");
	await clickSave();
	const readsBefore = calls.filter((c) => c.method === "GET").length;
	await act(async () => root.render(null));
	await mount("managed");
	expect(saveButton().disabled).toBe(true);
	expect(input("Organization token").disabled).toBe(true);
	expect(calls.filter((c) => c.method === "GET")).toHaveLength(readsBefore);
	release(key);
	await idle();
	expect(saveButton().disabled).toBe(false);
	expect(input("Organization token").value).toBe("rgw_reopened_a");
	expect(success.mock.calls).toEqual([]);
});
for (const [kind, status, pref, title] of [
	["managed", 503, "managed-gateway-url", "Could not load managed inference"],
	["mesh", 403, "mesh-login-server", "Could not load network settings"],
] as const)
	test(`${kind} initial read${status} is visible, cannot blank-save, and genuine Retry recovers owned values`, async () => {
		const key = `${signature(a)}:GET:/api/preferences/${pref}`;
		fail.add(key);
		refusalStatuses.set(key, status);
		await mount(kind);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			title,
		);
		const save = [
			...container.querySelectorAll<HTMLButtonElement>("button"),
		].find((button) => button.textContent?.trim() === "Save");
		expect(save === undefined || save.disabled).toBe(true);
		if (save) await clickSave();
		expect(
			calls.filter((c) => c.method === "PUT" || c.method === "POST"),
		).toEqual([]);
		await retryRead();
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(saveButton().disabled).toBe(false);
		expect(
			input(kind === "managed" ? "Fleet URL" : "Headscale control server URL")
				.value,
		).toBe(
			kind === "managed"
				? "https://fleet-a.example.test"
				: "https://headscale-a.example.test",
		);
		expect(
			calls.filter(
				(c) => c.path === `/api/preferences/${pref}` && c.method === "GET",
			),
		).toHaveLength(2);
	});
test("genuinely unset404 fleet values remain empty editable choices rather than a failed read", async () => {
	delete states[signature(a)]!.prefs["managed-gateway-url"];
	delete states[signature(a)]!.prefs["managed-gateway-token"];
	await mount("managed");
	expect(container.querySelector('[role="alert"]')).toBeNull();
	expect(input("Fleet URL").value).toBe("");
	expect(input("Organization token").value).toBe("");
	expect(saveButton().disabled).toBe(false);
	await clickSave();
	expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([
		{ value: "" },
		{ value: "" },
	]);
});
test("switching from managed controls to network controls waits for the same node's pending acknowledgment", async () => {
	await mount("managed");
	const key = `${signature(a)}:PUT:/api/preferences/managed-gateway-token`;
	holds.add(key);
	await fill("Organization token", "rgw_cross_card_a");
	await clickSave();
	const readsBefore = calls.filter((call) => call.method === "GET").length;
	await mount("mesh");
	expect(
		container.querySelector(
			'input[aria-label="Headscale control server URL"]',
		) === null,
	).toBe(true);
	expect(calls.filter((call) => call.method === "GET")).toHaveLength(
		readsBefore,
	);
	release(key);
	await idle();
	expect(input("Headscale control server URL").value).toBe(
		"https://headscale-a.example.test",
	);
	await fill(
		"Headscale control server URL",
		"https://cross-card-a.example.test",
	);
	await clickSave();
	expect(states[signature(a)]!.prefs["mesh-login-server"]).toBe(
		"https://cross-card-a.example.test",
	);
	expect(states[signature(a)]!.prefs["managed-gateway-token"]).toBe(
		"rgw_cross_card_a",
	);
	expect(success.mock.calls).toHaveLength(1);
});
