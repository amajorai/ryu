import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let target: ApiTarget;
let canConfigure: boolean;
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
const { createRoot } = await import("react-dom/client");
const { DefaultsSection } = await import("./DefaultsSection.tsx");
const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { queryClient } = await import("@/src/lib/query-client.ts");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const originalFetch = globalThis.fetch;
const roots: Root[] = [];
const first: ApiTarget = {
	url: "https://defaults-one.fixture",
	token: "one-token",
	userJwt: "one-user",
};
const idleKey = "engine.llamacpp.sleep-idle-seconds";
interface Call {
	authorization: string | null;
	body: { value: string } | null;
	identity: string | null;
	method: string;
	url: URL;
}
let calls: Call[];
let handler: (call: Call) => Response | Promise<Response>;
function deferred() {
	let resolve!: (value: Response) => void;
	const promise = new Promise<Response>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function selection(model: string) {
	return {
		agent_id: "ryu",
		provider: "local",
		model,
		thinking_level: "high",
		effort: "high",
		access_mode: "safe",
	};
}
beforeEach(() => {
	target = { ...first };
	canConfigure = true;
	calls = [];
	client.clear();
	queryClient.clear();
	handler = (call) =>
		Response.json({
			value: call.url.pathname.endsWith(idleKey)
				? "300"
				: JSON.stringify(selection("first-model")),
		});
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const headers = new Headers(init?.headers);
			const call: Call = {
				url,
				method: init?.method ?? "GET",
				authorization: headers.get("authorization"),
				identity: headers.get("x-ryu-user-jwt"),
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			if (
				[
					idleKey,
					"default-local-agent-selection",
					"default-cloud-agent-selection",
				].some((key) => url.pathname === `/api/preferences/${key}`)
			) {
				calls.push(call);
				return await handler(call);
			}
			if (url.pathname.startsWith("/api/preferences/")) {
				return Response.json({ value: null });
			}
			if (url.pathname.endsWith("/catalog")) {
				return Response.json({ providers: [], thinkingLevels: [] });
			}
			if (url.pathname === "/api/agents") {
				return Response.json({ agents: [] });
			}
			if (url.pathname === "/api/engines") {
				return Response.json({ engines: [] });
			}
			return Response.json({});
		},
		{ preconnect: originalFetch.preconnect }
	);
});
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	client.clear();
	queryClient.clear();
	document.body.replaceChildren();
	globalThis.fetch = originalFetch;
});
function view() {
	return (
		<QueryClientProvider client={client}>
			<EntitlementProvider>
				<DefaultsSection
					canConfigure={canConfigure}
					managed={false}
					target={target}
				/>
			</EntitlementProvider>
		</QueryClientProvider>
	);
}
async function settle() {
	await act(async () => {
		await Bun.sleep(30);
	});
}
async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(view()));
	await settle();
	return root;
}
async function switchTarget(root: Root, next: ApiTarget) {
	target = next;
	await act(async () => root.render(view()));
	await settle();
}
function idle() {
	const element = document.querySelector<HTMLElement>(
		'[aria-label="Auto-unload local model"]'
	);
	if (!element) {
		throw new Error("Missing idle control");
	}
	return element;
}
async function choose(label: string) {
	await act(async () => idle().click());
	await settle();
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((element) => element.textContent?.trim() === label);
	if (!option) {
		throw new Error(`Missing ${label} option`);
	}
	await act(async () => option.click());
	await settle();
}
for (const [name, second] of [
	["URL", { ...first, url: "https://defaults-two.fixture" }],
	["token", { ...first, token: "two-token" }],
	["JWT", { ...first, userJwt: "two-user" }],
] as const) {
	test(`late refused ${name} authority save cannot roll the new node's idle setting back`, async () => {
		const old = deferred();
		let current = "300";
		handler = (call) =>
			call.url.pathname.endsWith(idleKey)
				? call.method === "PUT"
					? old.promise
					: Response.json({ value: current })
				: Response.json({ value: JSON.stringify(selection("first-model")) });
		const root = await mount();
		await choose("1 minute");
		current = "900";
		await switchTarget(root, second);
		expect(idle().textContent).toContain("15 minutes");
		await act(async () =>
			old.resolve(
				Response.json({ error: "Old authority refused" }, { status: 403 })
			)
		);
		await settle();
		expect(idle().textContent).toContain("15 minutes");
		expect(calls.find((call) => call.method === "PUT")).toMatchObject({
			authorization: "Bearer one-token",
			identity: "one-user",
			body: { value: "60" },
		});
	});
}
test("equivalent authority objects retain current values without new preference reads", async () => {
	const root = await mount();
	const before = calls.length;
	await switchTarget(root, { ...first });
	expect(idle().textContent).toContain("5 minutes");
	expect(calls).toHaveLength(before);
});
test("failed initial reads cannot create a writable default that overwrites unknown saved state", async () => {
	handler = () =>
		Response.json({ error: "Permission refused" }, { status: 403 });
	await mount();
	expect(document.body.textContent).toContain("Could not load");
	expect(
		document.querySelector('[aria-label="Default local agent or model"]')
	).toBeNull();
	expect(
		document.querySelector('[aria-label="Auto-unload local model"]')
	).toBeNull();
	expect(calls.filter((call) => call.method === "PUT")).toEqual([]);
});
async function button(name: string) {
	const element = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find(
		(element) =>
			(element.getAttribute("aria-label") ?? element.textContent?.trim()) ===
			name
	);
	if (!element) {
		throw new Error(`Missing ${name}`);
	}
	await act(async () => element.click());
	await settle();
}
function cacheDialog() {
	return document.querySelector('[role="alertdialog"]');
}
async function remount(root: Root) {
	await act(async () => root.unmount());
	roots.splice(roots.indexOf(root), 1);
	return await mount();
}
async function model(lane: "local" | "cloud", name: string) {
	await button(`Default ${lane} agent or model`);
	const input = document.querySelector<HTMLInputElement>(
		'[aria-label="Custom model id"]'
	);
	if (!input) {
		throw new Error("Missing custom model input");
	}
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, name);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await button("Use this model");
}
test("initial refusal exposes a real retry which reads all saved settings before any write", async () => {
	let reject = true;
	handler = (call) =>
		reject
			? Response.json({ error: "Read denied" }, { status: 403 })
			: Response.json({
					value: call.url.pathname.endsWith(idleKey)
						? "900"
						: JSON.stringify(selection("recovered-model")),
				});
	await mount();
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		"Could not load"
	);
	reject = false;
	await button("Retry");
	expect(idle().textContent).toContain("15 minutes");
	expect(
		document.querySelector('[aria-label="Default local agent or model"]')
			?.textContent
	).toContain("recovered-model");
	expect(calls.filter((call) => call.method === "GET")).toHaveLength(6);
	expect(calls.filter((call) => call.method === "PUT")).toEqual([]);
});
test("idle saves lock pending edits, preserve stored units, roll back refusal and retry with authenticated readback", async () => {
	const pendingWrite = deferred();
	let stored = "300";
	let pending = true;
	const saveIdle = (value: string) => {
		stored = value;
		return Response.json({ success: true, value });
	};
	handler = (call) =>
		call.url.pathname.endsWith(idleKey)
			? call.method === "PUT"
				? pending
					? pendingWrite.promise
					: saveIdle(call.body!.value)
				: Response.json({ value: stored })
			: Response.json({ value: JSON.stringify(selection("first-model")) });
	const root = await mount();
	await choose("1 minute");
	expect((idle() as HTMLButtonElement).disabled).toBe(true);
	expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
	await act(async () =>
		pendingWrite.resolve(
			Response.json({ error: "Write denied" }, { status: 403 })
		)
	);
	await settle();
	expect(idle().textContent).toContain("5 minutes");
	expect((idle() as HTMLButtonElement).disabled).not.toBe(true);
	pending = false;
	await choose("Never");
	expect(stored).toBe("0");
	expect(
		calls
			.filter((call) => call.method === "PUT")
			.map((call) => [
				call.url.href,
				call.authorization,
				call.identity,
				call.body,
			])
	).toEqual([
		[
			`${first.url}/api/preferences/${idleKey}`,
			"Bearer one-token",
			"one-user",
			{ value: "60" },
		],
		[
			`${first.url}/api/preferences/${idleKey}`,
			"Bearer one-token",
			"one-user",
			{ value: "0" },
		],
	]);
	await remount(root);
	expect(idle().textContent).toContain("Never");
});
test("a successful old save neither unlocks a new node's pending save nor replaces its selected idle value", async () => {
	const old = deferred();
	const current = deferred();
	handler = (call) =>
		call.url.pathname.endsWith(idleKey)
			? call.method === "PUT"
				? call.authorization === "Bearer one-token"
					? old.promise
					: current.promise
				: Response.json({
						value: call.authorization === "Bearer one-token" ? "300" : "900",
					})
			: Response.json({ value: JSON.stringify(selection("first-model")) });
	const root = await mount();
	await choose("1 minute");
	await switchTarget(root, { ...first, token: "two-token" });
	await choose("30 minutes");
	await act(async () => old.resolve(Response.json({ success: true })));
	await settle();
	expect(idle().textContent).toContain("30 minutes");
	expect((idle() as HTMLButtonElement).disabled).toBe(true);
	await act(async () => current.resolve(Response.json({ success: true })));
	await settle();
	expect((idle() as HTMLButtonElement).disabled).not.toBe(true);
	expect(
		calls
			.filter((call) => call.method === "PUT")
			.map((call) => [call.authorization, call.body])
	).toEqual([
		["Bearer one-token", { value: "60" }],
		["Bearer two-token", { value: "1800" }],
	]);
});
for (const lane of ["local", "cloud"] as const) {
	test(`${lane} lane saves the complete custom model selection once, rolls refusal back, retries and survives remount`, async () => {
		const key = `default-${lane}-agent-selection`;
		let stored = selection("first-model");
		const pending = deferred();
		let reject = true;
		const saveSelection = (raw: string) => {
			stored = JSON.parse(raw);
			return Response.json({ success: true, value: stored });
		};
		handler = (call) =>
			call.url.pathname.endsWith(key)
				? call.method === "PUT"
					? reject
						? pending.promise
						: saveSelection(call.body!.value)
					: Response.json({ value: JSON.stringify(stored) })
				: Response.json({
						value: call.url.pathname.endsWith(idleKey)
							? "300"
							: JSON.stringify(selection("other-lane")),
					});
		const root = await mount();
		await model(lane, "  custom-model  ");
		// Chats run on the saved cloud lane, so only its change asks first.
		expect(cacheDialog() === null).toBe(lane === "local");
		if (lane === "cloud") {
			await button("Apply now");
		}
		expect(
			document.querySelector<HTMLButtonElement>(
				`[aria-label="Default ${lane} agent or model"]`
			)?.disabled
		).toBe(true);
		expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
		await act(async () =>
			pending.resolve(
				Response.json({ error: "Selection refused" }, { status: 403 })
			)
		);
		await settle();
		expect(
			document.querySelector(`[aria-label="Default ${lane} agent or model"]`)
				?.textContent
		).toContain("first-model");
		reject = false;
		await model(lane, "custom-model");
		if (lane === "cloud") {
			await button("Apply now");
		}
		const expected = { ...selection("custom-model"), provider: "" };
		expect(stored).toEqual(expected);
		expect(
			calls
				.filter((call) => call.method === "PUT")
				.map((call) => [
					call.url.href,
					call.authorization,
					call.identity,
					call.body,
				])
		).toEqual(
			Array.from({ length: 2 }, () => [
				`${first.url}/api/preferences/${key}`,
				"Bearer one-token",
				"one-user",
				{ value: JSON.stringify(expected) },
			])
		);
		await remount(root);
		expect(
			document.querySelector(`[aria-label="Default ${lane} agent or model"]`)
				?.textContent
		).toContain("custom-model");
		expect(
			document.querySelector(
				`[aria-label="Default ${lane === "local" ? "cloud" : "local"} agent or model"]`
			)?.textContent
		).toContain("other-lane");
	});
}
test("two different selections in one turn cannot issue overlapping idle writes", async () => {
	const pending = deferred();
	handler = (call) =>
		call.method === "PUT"
			? pending.promise
			: Response.json({
					value: call.url.pathname.endsWith(idleKey)
						? "300"
						: JSON.stringify(selection("first-model")),
				});
	await mount();
	await act(async () => idle().click());
	await settle();
	const options = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	];
	const minute = options.find(
		(option) => option.textContent?.trim() === "1 minute"
	);
	const never = options.find(
		(option) => option.textContent?.trim() === "Never"
	);
	if (!(minute && never)) {
		throw new Error("Missing real timeout choices");
	}
	await act(async () => {
		minute.click();
		never.click();
	});
	await settle();
	expect(
		calls.filter((call) => call.method === "PUT").map((call) => call.body)
	).toEqual([{ value: "60" }]);
	await act(async () => pending.resolve(Response.json({ success: true })));
	await settle();
	expect(idle().textContent).toContain("1 minute");
});
test("configure refusal disables both lane controls while the device idle setting still saves", async () => {
	canConfigure = false;
	handler = (call) =>
		Response.json({
			value: call.url.pathname.endsWith(idleKey)
				? "300"
				: JSON.stringify(selection("first-model")),
		});
	await mount();
	for (const lane of ["local", "cloud"]) {
		const trigger = document.querySelector<HTMLButtonElement>(
			`[aria-label="Default ${lane} agent or model"]`
		);
		expect(trigger?.disabled).toBe(true);
		await act(async () => trigger?.click());
	}
	expect(document.querySelector('[aria-label="Custom model id"]')).toBeNull();
	await choose("1 minute");
	expect(
		calls
			.filter((call) => call.method === "PUT")
			.map((call) => [call.url.pathname, call.body])
	).toEqual([[`/api/preferences/${idleKey}`, { value: "60" }]]);
});
test("absent and null delegation are the same authority and do not reload saved controls", async () => {
	target = { ...first, userJwt: null };
	const root = await mount();
	const reads = calls.length;
	await switchTarget(root, { ...first, userJwt: undefined });
	expect(calls).toHaveLength(reads);
	expect(idle().textContent).toContain("5 minutes");
});
test("a cloud-lane model change asks first and Cancel leaves the saved lane untouched", async () => {
	let stored = selection("first-model");
	handler = (call) => {
		if (!call.url.pathname.endsWith("default-cloud-agent-selection")) {
			return Response.json({
				value: call.url.pathname.endsWith(idleKey)
					? "300"
					: JSON.stringify(selection("local-model")),
			});
		}
		if (call.method === "PUT") {
			stored = JSON.parse(call.body?.value ?? "{}");
			return Response.json({ success: true, value: stored });
		}
		return Response.json({ value: JSON.stringify(stored) });
	};
	await mount();
	await model("cloud", "switched-model");
	expect(cacheDialog()?.textContent).toContain(
		"Every thread that inherits the node-wide cloud default switches model"
	);
	await button("Cancel");
	expect(cacheDialog()).toBeNull();
	expect(calls.filter((call) => call.method === "PUT")).toEqual([]);
	expect(
		document.querySelector('[aria-label="Default cloud agent or model"]')
			?.textContent
	).toContain("first-model");
	await model("cloud", "switched-model");
	await button("Apply now");
	expect(stored).toEqual({ ...selection("switched-model"), provider: "" });
});
test("the local lane asks only while chats fall back to it", async () => {
	handler = (call) =>
		call.method === "PUT"
			? Response.json({ success: true })
			: Response.json({
					value: call.url.pathname.endsWith(idleKey)
						? "300"
						: call.url.pathname.endsWith("default-cloud-agent-selection")
							? ""
							: JSON.stringify(selection("local-model")),
				});
	await mount();
	await model("local", "switched-local");
	expect(cacheDialog()?.textContent).toContain(
		"Every thread that inherits the node-wide local default switches model"
	);
	await button("Apply now");
	expect(
		calls
			.filter((call) => call.method === "PUT")
			.map((call) => call.url.pathname)
	).toEqual(["/api/preferences/default-local-agent-selection"]);
});
