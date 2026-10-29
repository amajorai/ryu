import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import type { GatewayProvidersConfig } from "@/src/lib/api/gateway.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Every mirror the card asked the OS credential store for, in order. */
let keychainCalls: Array<{ key: string | null; provider: string }> = [];
// The desktop bridge's storage refusals propagate from the real helper (see
// `tauri-ready.test.ts`); this stands in for a bridge that refuses every write.
mock.module("@/src/lib/api/secrets.ts", () => ({
	syncGatewayProviderKey: (provider: string, key: string | null) => {
		keychainCalls.push({ key, provider });
		return Promise.reject(new Error("OS credential store is unavailable"));
	},
}));
const { createRoot } = await import("react-dom/client");
const { ByokCard } = await import("./ByokCard.tsx");
const { fetchGatewayConfig } = await import("@/src/lib/api/gateway.ts");

const target = { url: "http://gateway.test:7980", token: null };
const realFetch = globalThis.fetch;
const roots: Root[] = [];

/** The Gateway's persisted OpenAI key; null when the Gateway holds none. */
let gatewayKey: string | null = null;
let configReads = 0;
let gatewayWrites: Array<string | null> = [];

function providersView(): GatewayProvidersConfig {
	// The Gateway serializes every core provider slot, unset ones as null.
	return {
		anthropic: null,
		core: null,
		genai: { keys: [] },
		local: null,
		openrouter: null,
		openai: gatewayKey
			? { api_key: "***", base_url: "https://api.openai.com" }
			: null,
	};
}

function installGateway() {
	globalThis.fetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit
	) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname === "/api/gateway/config") {
			configReads += 1;
			return Response.json({
				auth: { api_keys: [], require_auth: false },
				providers: providersView(),
			});
		}
		if (url.pathname === "/api/gateway/providers" && init?.method === "PUT") {
			const body: { api_key: string | null } = JSON.parse(String(init.body));
			gatewayWrites.push(body.api_key);
			gatewayKey = body.api_key;
			return Response.json({ success: true, gateway_restarted: true });
		}
		return Response.json({ error: "Unexpected request" }, { status: 404 });
	}) as typeof fetch;
}

function Surface() {
	const [providers, setProviders] =
		useState<GatewayProvidersConfig>(providersView);
	return (
		<ByokCard
			onRefresh={async () => {
				const config = await fetchGatewayConfig(target);
				setProviders(config.providers ?? providersView());
			}}
			providers={providers}
			target={target}
		/>
	);
}

async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(<Surface />));
}

function openaiRow(): HTMLElement {
	const input = document.querySelector('input[aria-label="OpenAI API key"]');
	const row = input?.closest('[data-slot="item"]');
	if (!(row instanceof HTMLElement)) {
		throw new Error("Missing OpenAI provider row");
	}
	return row;
}

function openaiInput(): HTMLInputElement {
	const input = openaiRow().querySelector('input[aria-label="OpenAI API key"]');
	if (!(input instanceof HTMLInputElement)) {
		throw new Error("Missing OpenAI key input");
	}
	return input;
}

function rowButton(name: string): HTMLButtonElement {
	const button = [...openaiRow().querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === name
	);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Missing ${name} button`);
	}
	return button;
}

function spendLimitCheckbox(): HTMLElement {
	const checkbox = openaiRow().querySelector('[role="checkbox"]');
	if (!(checkbox instanceof HTMLElement)) {
		throw new Error("Missing spend-limit confirmation");
	}
	return checkbox;
}

async function typeOpenaiKey(value: string) {
	const input = openaiInput();
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function settle() {
	for (let tick = 0; tick < 10; tick++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}

beforeEach(() => {
	gatewayKey = null;
	configReads = 0;
	gatewayWrites = [];
	keychainCalls = [];
	installGateway();
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

test("a provider key cannot be saved until its spending limit is confirmed", async () => {
	await mount();
	expect(document.body.textContent).toContain(
		"Set a spending limit on every provider key"
	);
	await typeOpenaiKey("sk-openai-test");
	expect(openaiRow().textContent).toContain(
		"I have set a spending limit for this key at OpenAI"
	);
	expect(rowButton("Save").disabled).toBe(true);
	await act(async () => {
		rowButton("Save").click();
	});
	await settle();
	expect(gatewayWrites).toEqual([]);

	await act(async () => {
		spendLimitCheckbox().click();
	});
	expect(rowButton("Save").disabled).toBe(false);
});

test("a persisted Gateway save refreshes to the held key and surfaces the keychain mirror failure", async () => {
	await mount();
	expect(openaiRow().textContent).toContain("No key");
	await typeOpenaiKey("sk-openai-test");
	await act(async () => {
		spendLimitCheckbox().click();
	});
	await act(async () => {
		rowButton("Save").click();
	});
	await settle();

	expect(gatewayWrites).toEqual(["sk-openai-test"]);
	expect(keychainCalls).toEqual([
		{ key: "sk-openai-test", provider: "openai" },
	]);
	expect(configReads).toBe(1);
	const row = openaiRow().textContent ?? "";
	expect(row).toContain("Key set");
	expect(row).not.toContain("No key");
	expect(row).toContain(
		"Key saved to the Gateway, but the OS credential store could not be updated: OS credential store is unavailable"
	);
	// The draft stays so the user can retry the mirror without retyping.
	expect(openaiInput().value).toBe("sk-openai-test");
});

test("a persisted Gateway clear refreshes to no key and surfaces the keychain mirror failure", async () => {
	gatewayKey = "sk-openai-existing";
	await mount();
	expect(openaiRow().textContent).toContain("Key set");
	await act(async () => {
		rowButton("Clear").click();
	});
	await settle();

	expect(gatewayWrites).toEqual([null]);
	expect(keychainCalls).toEqual([{ key: null, provider: "openai" }]);
	expect(configReads).toBe(1);
	const row = openaiRow().textContent ?? "";
	expect(row).toContain("No key");
	expect(row).not.toContain("Key set");
	expect(row).toContain(
		"Key removed from the Gateway, but the OS credential store could not be updated: OS credential store is unavailable"
	);
});
