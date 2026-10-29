import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
mock.module("@/src/lib/api/managed-nodes.ts", () => ({
	fetchManagedNodes: async () => [],
}));
const { createRoot } = await import("react-dom/client");
const { useNodeStore, stopAutoSelectProbe, stopCloudTokenRefresh } =
	await import("@/src/store/useNodeStore.ts");
const { EmailAlertsSettings } = await import("./EmailAlertsSettings.tsx");
const realFetch = globalThis.fetch;
const roots: Root[] = [];
const nodes = [
	{
		name: "one",
		url: "https://one.fixture",
		token: "one-token",
		userJwt: null,
	},
	{
		name: "two",
		url: "https://two.fixture",
		token: "two-token",
		userJwt: null,
	},
];
interface Call {
	authorization: string | null;
	body: unknown;
	method: string;
	url: URL;
}
let calls: Call[] = [];
let handler: (call: Call) => Response | Promise<Response>;

function transport(host: string) {
	return {
		host,
		port: 587,
		from: "alerts@example.com",
		username: "relay-user",
		starttls: true,
		passwordSet: true,
	};
}
function response(call: Call): Response {
	if (call.url.pathname === "/api/email/transport") {
		return Response.json(transport(`smtp.${call.url.hostname}`));
	}
	if (call.url.pathname === "/api/alerts/delivery") {
		return Response.json({
			emails: [`ops@${call.url.hostname}`],
			targets: [{ kind: "expo_push", token: `push-${call.url.hostname}` }],
		});
	}
	return Response.json({ ok: true });
}
beforeEach(() => {
	stopAutoSelectProbe();
	stopCloudTokenRefresh();
	calls = [];
	handler = response;
	useNodeStore.setState({ nodes, defaultNode: "one", tabOverrides: {} });
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const call: Call = {
				url: new URL(String(input)),
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
				authorization: new Headers(init?.headers).get("authorization"),
			};
			calls.push(call);
			return await handler(call);
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
	stopAutoSelectProbe();
	stopCloudTokenRefresh();
	document.body.replaceChildren();
	globalThis.fetch = realFetch;
});
async function flush() {
	await act(async () => {
		await Bun.sleep(20);
	});
}
async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(<EmailAlertsSettings />));
	await flush();
}
function input(selector: string): HTMLInputElement {
	const element = document.querySelector<HTMLInputElement>(selector);
	if (!element) {
		throw new Error(`Missing input: ${selector}`);
	}
	return element;
}
async function fill(selector: string, value: string) {
	const element = input(selector);
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function click(name: string) {
	const button = [...document.querySelectorAll("button")].find(
		(element) => element.textContent?.trim() === name
	);
	if (!button) {
		throw new Error(`Missing button: ${name}`);
	}
	await act(async () => button.click());
	await flush();
}
async function switchNode(name: string) {
	await act(async () => useNodeStore.setState({ defaultNode: name }));
	await flush();
}

test("switching self-hosted nodes reloads both editors and never saves another node's draft", async () => {
	await mount();
	expect(input("#smtp-host").value).toBe("smtp.one.fixture");
	await fill("#smtp-host", "smtp.unsaved-one.example");
	await fill("#smtp-password", "one-only-secret");
	await switchNode("two");
	expect(input("#smtp-host").value).toBe("smtp.two.fixture");
	expect(input("#smtp-password").value).toBe("");
	expect(input('[aria-label="Email recipient 1"]').value).toBe(
		"ops@two.fixture"
	);
	await click("Save");
	const writes = calls.filter((call) => call.method === "PUT");
	expect(writes).toHaveLength(1);
	expect(writes[0]?.url.hostname).toBe("two.fixture");
	expect(writes[0]?.authorization).toBe("Bearer two-token");
	expect(writes[0]?.body).toEqual({
		...transport("smtp.two.fixture"),
		passwordSet: undefined,
	});
});

test("a test email started on one node saves and sends on that same node after switching", async () => {
	let releaseSave: (() => void) | undefined;
	const saved = new Promise<void>((resolve) => {
		releaseSave = resolve;
	});
	handler = async (call) => {
		if (call.method === "PUT" && call.url.pathname === "/api/email/transport") {
			await saved;
		}
		return response(call);
	};
	await mount();
	await fill("#smtp-test", "recipient@example.com");
	await click("Send test");
	expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
	expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
	await switchNode("two");
	expect(input("#smtp-host").value).toBe("smtp.two.fixture");
	releaseSave?.();
	await flush();
	const mutations = calls.filter((call) => call.method !== "GET");
	expect(
		mutations.map((call) => [
			call.method,
			call.url.hostname,
			call.authorization,
		])
	).toEqual([
		["PUT", "one.fixture", "Bearer one-token"],
		["POST", "one.fixture", "Bearer one-token"],
	]);
	expect(mutations[1]?.body).toEqual({ to: "recipient@example.com" });
});

test("a late response from a previous node cannot replace the new node's settings", async () => {
	let releaseLoad: (() => void) | undefined;
	const loaded = new Promise<void>((resolve) => {
		releaseLoad = resolve;
	});
	handler = async (call) => {
		if (call.url.hostname === "one.fixture") {
			await loaded;
		}
		return response(call);
	};
	await mount();
	expect(input("#smtp-host").disabled).toBe(true);
	await switchNode("two");
	expect(input("#smtp-host").value).toBe("smtp.two.fixture");
	releaseLoad?.();
	await flush();
	expect(input("#smtp-host").value).toBe("smtp.two.fixture");
	expect(input('[aria-label="Email recipient 1"]').value).toBe(
		"ops@two.fixture"
	);
});

test("redacted alert credentials round-trip by reference and a typed URL replaces one", async () => {
	handler = (call) => {
		if (call.url.pathname === "/api/alerts/delivery" && call.method === "GET") {
			return Response.json({
				emails: ["ops@one.fixture"],
				targets: [
					{
						kind: "webhook",
						url: "••••••",
						preview: "hooks.slack.test",
						secret_ref: "ref-webhook",
					},
					{
						kind: "telegram",
						bot_token: "••••••",
						chat_id: "42",
						secret_ref: "ref-telegram",
					},
				],
			});
		}
		return response(call);
	};
	await mount();
	expect(document.body.textContent).toContain("Saved · hooks.slack.test");
	await click("Remove");
	const removed = calls.filter(
		(call) =>
			call.method === "PUT" && call.url.pathname === "/api/alerts/delivery"
	);
	expect(removed.at(-1)?.body).toEqual({
		emails: [],
		targets: [
			{ kind: "webhook", url: "••••••", secret_ref: "ref-webhook" },
			{
				kind: "telegram",
				bot_token: "••••••",
				chat_id: "42",
				secret_ref: "ref-telegram",
			},
		],
	});
	await fill('[aria-label="Webhook URL 1"]', "https://hooks.new.test/x");
	await act(async () => {
		input('[aria-label="Webhook URL 1"]').dispatchEvent(
			new FocusEvent("focusout", { bubbles: true })
		);
	});
	await flush();
	const replaced = calls.filter(
		(call) =>
			call.method === "PUT" && call.url.pathname === "/api/alerts/delivery"
	);
	const body = replaced.at(-1)?.body as { targets: unknown[] };
	expect(body.targets[0]).toEqual({
		kind: "webhook",
		url: "https://hooks.new.test/x",
	});
});
