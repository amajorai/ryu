import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	PluginSettingsField,
	PluginSettingsTab,
} from "@/src/lib/pluginSettings.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { PluginSettingsFields } = await import("./PluginSettingsFields.tsx");
const realFetch = globalThis.fetch;
const roots: Root[] = [];
const one: ApiTarget = { url: "https://one.fixture", token: "one-token" };
const two: ApiTarget = { url: "https://two.fixture", token: "two-token" };
interface Call {
	authorization: string | null;
	body: unknown;
	method: string;
	url: URL;
}
let calls: Call[];
let handler: (call: Call) => Response | Promise<Response>;
function field(
	type: string,
	extra: Partial<PluginSettingsField> = {}
): PluginSettingsField {
	return {
		type,
		label: "Fixture field",
		prefKey: "fixture",
		options: [],
		...extra,
	};
}
function tabs(
	fields: PluginSettingsField[],
	plugin = "com.fixture"
): PluginSettingsTab[] {
	return [
		{
			id: "fixture",
			title: "Fixture",
			plugin,
			enabled: true,
			scope: "node",
			fields,
		},
	];
}
function respond(call: Call) {
	if (call.url.pathname.endsWith("/secrets")) {
		return Response.json({ secrets: [] });
	}
	if (call.method === "GET") {
		return Response.json({ key: "fixture", value: "10" });
	}
	return Response.json({ ok: true });
}
beforeEach(() => {
	calls = [];
	handler = respond;
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
	document.body.replaceChildren();
	globalThis.fetch = realFetch;
});
async function flush() {
	await act(async () => {
		await Bun.sleep(20);
	});
}
async function mount(
	fields: PluginSettingsField[],
	target = one,
	plugin = "com.fixture"
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () =>
		root.render(
			<PluginSettingsFields tabs={tabs(fields, plugin)} target={target} />
		)
	);
	await flush();
	return root;
}
function input(): HTMLInputElement {
	const element = document.querySelector<HTMLInputElement>(
		'input[aria-label="Fixture field"]'
	);
	if (!element) {
		throw new Error("Missing fixture input");
	}
	return element;
}
async function fill(value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input(), value);
		input().dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function blur() {
	await act(async () =>
		input().dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
	);
	await flush();
}
async function click(name: string) {
	const element = [...document.querySelectorAll("button")].find(
		(button) => button.textContent?.trim() === name
	);
	if (!element) {
		throw new Error(`Missing ${name}`);
	}
	await act(async () => element.click());
	await flush();
}

test("bounded number rejects out-of-range edits and rolls back refused writes before a successful retry", async () => {
	let refuse = true;
	handler = (call) =>
		call.method === "PUT" && refuse
			? Response.json({ error: "Unavailable" }, { status: 503 })
			: respond(call);
	await mount([field("number", { min: 5, max: 20, step: 5 })]);
	expect(input().value).toBe("10");
	await fill("25");
	await blur();
	expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
	expect(input().value).toBe("10");
	await fill("15");
	await blur();
	expect(input().value).toBe("10");
	refuse = false;
	await fill("15");
	await blur();
	expect(input().value).toBe("15");
	expect(
		calls.filter((call) => call.method === "PUT").map((call) => call.body)
	).toEqual([{ value: "15" }, { value: "15" }]);
	await blur();
	expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2);
});

test("clearing a number persists unset rather than zero and survives remount", async () => {
	let stored = "10";
	handler = (call) => {
		if (call.method === "PUT") {
			stored = (call.body as { value: string }).value;
		}
		return Response.json({ key: "fixture", value: stored });
	};
	const root = await mount([field("number", { min: 5 })]);
	await fill("");
	await blur();
	expect(stored).toBe("");
	await act(async () => root.unmount());
	roots.splice(roots.indexOf(root), 1);
	await mount([field("number", { min: 5 })]);
	expect(input().value).toBe("");
	expect(
		calls.filter((call) => call.method === "PUT").map((call) => call.body)
	).toEqual([{ value: "" }]);
});

test("switching nodes discards secret drafts so another node never receives the previous node's credential", async () => {
	const fields = [field("secret", { prefKey: "API_KEY" })];
	const root = await mount(fields);
	await fill("one-only-secret");
	await act(async () =>
		root.render(<PluginSettingsFields tabs={tabs(fields)} target={two} />)
	);
	await flush();
	expect(input().value).toBe("");
	await fill("two-only-secret");
	await click("Save");
	const writes = calls.filter((call) => call.method === "PUT");
	expect(writes).toHaveLength(1);
	expect(writes[0]?.url.hostname).toBe("two.fixture");
	expect(writes[0]?.authorization).toBe("Bearer two-token");
	expect(writes[0]?.body).toEqual({ value: "two-only-secret" });
	expect(
		calls.some((call) => call.url.pathname.includes("/preferences/"))
	).toBe(false);
});

test("switching plugin owner discards drafts even when its settings tab and secret field use the same IDs", async () => {
	const fields = [field("secret", { prefKey: "API_KEY" })];
	const root = await mount(fields);
	await fill("first-plugin-only");
	await act(async () =>
		root.render(
			<PluginSettingsFields tabs={tabs(fields, "com.other")} target={one} />
		)
	);
	await flush();
	expect(input().value).toBe("");
	await fill("other-plugin-only");
	await click("Save");
	const writes = calls.filter((call) => call.method === "PUT");
	expect(writes).toHaveLength(1);
	expect(writes[0]?.url.pathname).toBe(
		"/api/plugins/com.other/secrets/API_KEY"
	);
	expect(writes[0]?.body).toEqual({ value: "other-plugin-only" });
});

test("a failed preference read exposes retry and never lets default values overwrite saved settings", async () => {
	let offline = true;
	handler = (call) =>
		offline
			? Response.json({ error: "Offline" }, { status: 503 })
			: respond(call);
	await mount([field("number", { default: 5 })]);
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		"Couldn't load this setting"
	);
	expect(
		document.querySelector('input[aria-label="Fixture field"]')
	).toBeNull();
	expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
	offline = false;
	await click("Retry");
	expect(input().value).toBe("10");
	expect(document.querySelector('[role="alert"]')).toBeNull();
	await fill("15");
	await blur();
	expect(
		calls.filter((call) => call.method === "PUT").map((call) => call.body)
	).toEqual([{ value: "15" }]);
});

test("pending and late previous-node preference reads cannot enable an editor or replace the new node's value", async () => {
	let release: (() => void) | undefined;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	handler = async (call) => {
		if (call.url.hostname === "one.fixture") {
			await pending;
		}
		return Response.json({
			key: "fixture",
			value: call.url.hostname === "one.fixture" ? "old" : "new",
		});
	};
	const fields = [field("text")];
	const root = await mount(fields);
	expect(document.querySelector('[role="status"]')?.textContent).toContain(
		"Loading"
	);
	expect(
		document.querySelector('input[aria-label="Fixture field"]')
	).toBeNull();
	await act(async () =>
		root.render(<PluginSettingsFields tabs={tabs(fields)} target={two} />)
	);
	await flush();
	expect(input().value).toBe("new");
	release?.();
	await flush();
	expect(input().value).toBe("new");
});

test("failed secret writes preserve the only copy of the draft for retry and never use preferences", async () => {
	let fail = true;
	handler = (call) =>
		call.method === "PUT" && fail
			? Response.json({ error: "Unavailable" }, { status: 503 })
			: respond(call);
	await mount([field("secret", { prefKey: "API_KEY" })]);
	await fill("  only-copy  ");
	await click("Save");
	expect(input().value).toBe("  only-copy  ");
	expect(document.body.textContent).toContain("Not set");
	fail = false;
	await click("Save");
	expect(input().value).toBe("");
	expect(document.body.textContent).toContain("Set");
	expect(
		calls.filter((call) => call.method === "PUT").map((call) => call.body)
	).toEqual([{ value: "only-copy" }, { value: "only-copy" }]);
	expect(
		calls.some((call) => call.url.pathname.includes("/preferences/"))
	).toBe(false);
});

test("a toggle reads the stored boolean, rolls back a rejected write, and retries the exact string", async () => {
	let fail = true;
	handler = (call) => {
		if (call.method === "GET") {
			return Response.json({ key: "fixture", value: "false" });
		}
		return fail
			? Response.json({ error: "Unavailable" }, { status: 503 })
			: Response.json({ ok: true });
	};
	await mount([field("toggle", { default: true })]);
	function control() {
		const element = document.querySelector<HTMLElement>('[role="switch"]');
		if (!element) {
			throw new Error("Missing switch");
		}
		return element;
	}
	expect(control().getAttribute("aria-checked")).toBe("false");
	await act(async () => control().click());
	await flush();
	expect(control().getAttribute("aria-checked")).toBe("false");
	fail = false;
	await act(async () => control().click());
	await flush();
	expect(control().getAttribute("aria-checked")).toBe("true");
	expect(
		calls.filter((call) => call.method === "PUT").map((call) => call.body)
	).toEqual([{ value: "true" }, { value: "true" }]);
});

test.each([
	"text",
	"number",
	"secret",
])("equivalent target rerenders preserve an unsaved %s draft without another read", async (type) => {
	const fields = [
		field(type, { prefKey: type === "secret" ? "API_KEY" : "fixture" }),
	];
	const root = await mount(fields);
	const draft = type === "number" ? "15" : "only-unsaved-copy";
	await fill(draft);
	const readsBefore = calls.filter((call) => call.method === "GET").length;
	await act(async () =>
		root.render(
			<PluginSettingsFields
				tabs={tabs(fields)}
				target={{ ...one, userJwt: null }}
			/>
		)
	);
	await flush();
	expect(input().value).toBe(draft);
	expect(calls.filter((call) => call.method === "GET")).toHaveLength(
		readsBefore
	);
	expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
});
