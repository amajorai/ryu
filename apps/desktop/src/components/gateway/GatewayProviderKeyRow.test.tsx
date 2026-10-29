import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { GatewayProviderAccount } from "@/src/lib/api/gateway.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { ProviderRow } = await import("./GatewayProviderKeyRow.tsx");
const { configureGatewayProviderAccount } = await import(
	"@/src/lib/api/gateway.ts"
);
const realFetch = globalThis.fetch;
const roots: Root[] = [];
const account: GatewayProviderAccount = {
	id: "fixture",
	name: "Personal",
	enabled: true,
	priority: 0,
	source: "stored",
	drainThresholdPercent: 75,
};
const unusedCredentialAction = () => Promise.resolve();

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	globalThis.fetch = realFetch;
});

async function mount(quotaRouting = true, readOnly = false) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () =>
		root.render(
			<ProviderRow
				accountCount={1}
				accounts={[account]}
				isSet
				label="OpenAI"
				onAdd={unusedCredentialAction}
				onClear={unusedCredentialAction}
				onConfigure={(provider, updated) =>
					configureGatewayProviderAccount(
						{ url: "http://fixture.test", token: null, userJwt: null },
						provider,
						updated
					)
				}
				onRemove={unusedCredentialAction}
				onSave={unusedCredentialAction}
				placeholder="API key"
				quotaRouting={quotaRouting}
				readOnly={readOnly}
				slug="openai"
			/>
		)
	);
}

async function fill(value: string) {
	const input = document.querySelector(
		'input[aria-label="OpenAI Personal drain override"]'
	);
	if (!(input instanceof HTMLInputElement)) {
		throw new Error("Missing drain control");
	}
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

function saveButton() {
	const button = Array.from(document.querySelectorAll("button")).find(
		(item) => item.textContent?.trim() === "Save account"
	);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error("Missing account save");
	}
	return button;
}

test("account drain sends explicit zero and clears to provider inheritance without saving invalid percentages", async () => {
	const writes: unknown[] = [];
	globalThis.fetch = Object.assign(
		async (_input: RequestInfo | URL, init?: RequestInit) => {
			writes.push(JSON.parse(String(init?.body)));
			return Response.json({
				success: true,
				accountsApplied: true,
				gateway_restarted: false,
			});
		},
		{ preconnect: realFetch.preconnect }
	);
	await mount();
	await fill("101");
	expect(saveButton().disabled).toBe(true);
	await fill("0");
	expect(saveButton().disabled).toBe(false);
	await act(async () => {
		saveButton().click();
		await Bun.sleep(20);
	});
	expect(writes[0]).toMatchObject({
		accountPolicy: { drain_threshold_percent: 0 },
	});
	await fill("");
	await act(async () => {
		saveButton().click();
		await Bun.sleep(20);
	});
	expect(writes[1]).toMatchObject({
		accountPolicy: { drain_threshold_percent: null },
	});
});

test("quota-unobserved and read-only accounts expose no drain override", async () => {
	await mount(false);
	expect(
		document.querySelector('input[aria-label="OpenAI Personal drain override"]')
	).toBeNull();
	await mount(true, true);
	expect(
		document.querySelector('input[aria-label="OpenAI Personal drain override"]')
	).toBeNull();
});

test("an unsaved replacement credential survives a refreshed provider config", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const render = (accounts: GatewayProviderAccount[]) =>
		act(async () =>
			root.render(
				<ProviderRow
					accountCount={accounts.length}
					accounts={accounts}
					isSet
					label="Groq"
					onAdd={unusedCredentialAction}
					onClear={unusedCredentialAction}
					onConfigure={unusedCredentialAction}
					onRemove={unusedCredentialAction}
					onReplace={unusedCredentialAction}
					onSave={unusedCredentialAction}
					placeholder="API key"
					slug="genai-groq"
				/>
			)
		);
	await render([structuredClone(account)]);
	const input = document.querySelector(
		'input[aria-label="Groq Personal replacement credential"]'
	);
	if (!(input instanceof HTMLInputElement)) {
		throw new Error("Missing replacement credential control");
	}
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, "synthetic-unsaved-draft");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	// A config refresh hands every account back as a fresh object.
	await render([{ ...structuredClone(account), priority: 1 }]);
	const refreshed = document.querySelector(
		'input[aria-label="Groq Personal replacement credential"]'
	);
	expect(refreshed).toBe(input);
	expect(input.value).toBe("synthetic-unsaved-draft");
});
