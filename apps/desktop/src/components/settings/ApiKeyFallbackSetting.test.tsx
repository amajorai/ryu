import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type {
	ApiKeyFallback,
	ProviderCredential,
} from "@/src/lib/api/provider-credentials.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { ApiKeyFallbackSetting } = await import("./ApiKeyFallbackSetting.tsx");

const roots: Root[] = [];
let changes: boolean[];

const key = (
	accountId: string,
	label: string,
	hint: string | null,
	change: Partial<ProviderCredential> = {}
): ProviderCredential => ({
	accountId,
	label,
	hint,
	kind: "api_key",
	enabled: true,
	needsReauth: false,
	resting: null,
	...change,
});
const fallback = (change: Partial<ApiKeyFallback> = {}): ApiKeyFallback => ({
	supported: true,
	enabled: false,
	keyProviderId: "anthropic",
	keys: [],
	...change,
});

async function mount(value: ApiKeyFallback, busy = false) {
	changes = [];
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () =>
		root.render(
			<ApiKeyFallbackSetting
				busy={busy}
				fallback={value}
				keyProviderLabel="Anthropic"
				onChange={(enabled) => changes.push(enabled)}
			/>
		)
	);
}

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
});

const section = () =>
	document.querySelector<HTMLElement>('[data-slot="api-key-fallback"]');
function toggle() {
	const element = document.querySelector<HTMLElement>('[role="switch"]');
	if (!element) {
		throw new Error("Missing fallback switch");
	}
	return element;
}
const keyRows = () =>
	[...document.querySelectorAll('[data-slot="fallback-keys"] > li')].map(
		(row) => ({
			state: row.getAttribute("data-state"),
			// One part per cell: place, label, key hint (if any), state.
			text: [...row.children]
				.map((cell) => (cell.textContent ?? "").trim())
				.join(" "),
		})
	);

test("nothing is shown for a provider that cannot switch to an API key", async () => {
	await mount(fallback({ supported: false, keyProviderId: null }));
	expect(section()).toBeNull();
	expect(document.querySelector('[role="switch"]')).toBeNull();
});

test("the setting is off unless Core says on, and says an API key is never used", async () => {
	await mount(fallback({ keys: [key("work", "Work", "0001")] }));
	expect(toggle().getAttribute("aria-checked")).toBe("false");
	expect(section()?.textContent).toContain(
		"Use API keys when subscription accounts run out"
	);
	expect(section()?.textContent).toContain(
		"Off. A subscription account at its limit waits until the limit resets. An API key is never used in its place."
	);
	// The keys are not listed while they cannot take over.
	expect(document.querySelector('[data-slot="fallback-keys"]')).toBeNull();
	expect(section()?.textContent).not.toContain("Work");
});

test("turning the switch on asks for the change and never flips by itself", async () => {
	await mount(fallback());
	await act(async () => toggle().click());
	expect(changes).toEqual([true]);
	// The switch shows what Core holds, so it stays off until that changes.
	expect(toggle().getAttribute("aria-checked")).toBe("false");
});

test("turning the switch off asks for the change", async () => {
	await mount(fallback({ enabled: true, keys: [key("work", "Work", "0001")] }));
	expect(toggle().getAttribute("aria-checked")).toBe("true");
	await act(async () => toggle().click());
	expect(changes).toEqual([false]);
});

test("the switch cannot be used while a change is being saved", async () => {
	await mount(fallback(), true);
	await act(async () => toggle().click());
	expect(changes).toEqual([]);
});

test("when on, the keys are listed in the order they are tried with their state", async () => {
	await mount(
		fallback({
			enabled: true,
			keys: [
				key("spare", "Spare", "0002"),
				key("work", "Work", "0001", { resting: "limited" }),
				key("old", "Old", null, { resting: "rejected" }),
				key("unused", "Unused", "0004", { enabled: false, resting: "limited" }),
			],
		})
	);
	expect(section()?.textContent).toContain(
		"On. When every subscription account you use here is at its limit or failing, the next request uses your first Anthropic API key. API keys are billed per request."
	);
	expect(section()?.textContent).toContain(
		"Anthropic API keys, in the order they are tried"
	);
	expect(keyRows()).toEqual([
		{ state: "ready", text: "1 Spare Key ending in 0002 Ready" },
		{
			state: "limited",
			text: "2 Work Key ending in 0001 At its limit, waiting",
		},
		{
			state: "rejected",
			text: "3 Old Refused by the provider, will be tried again",
		},
		{ state: "off", text: "4 Unused Key ending in 0004 Turned off" },
	]);
	expect(document.querySelector('[role="status"]')).toBeNull();
});

test("when on with no saved key, it says nothing can take over yet", async () => {
	await mount(fallback({ enabled: true }));
	expect(document.querySelector('[role="status"]')?.textContent).toBe(
		"No Anthropic API key is saved, so nothing can take over yet. Add one in the Anthropic settings."
	);
	expect(document.querySelector('[data-slot="fallback-keys"]')).toBeNull();
});
