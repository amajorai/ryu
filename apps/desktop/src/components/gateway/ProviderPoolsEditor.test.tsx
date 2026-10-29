import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { GatewayProviderPool } from "@/src/lib/api/gateway.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { ProviderPoolsEditor } = await import("./ProviderPoolsEditor.tsx");

// The Gateway registers `openai-credits` beside `openai` when a donated OpenAI
// allowance is configured, so the editor is handed both ids side by side.
const DONATED_LABEL = "OpenAI (donated credits)";
const PROVIDERS = ["anthropic", "openai", "openai-credits"];
const roots: Root[] = [];

const POOLS: Record<string, GatewayProviderPool> = {
	donated: {
		strategy: "fusion",
		members: [
			{
				provider: "openai",
				model: "gpt-4o-mini",
				priority: 0,
				weight: 1,
				enabled: true,
				last_resort: false,
			},
			{
				provider: "openai-credits",
				model: "gpt-4o",
				priority: 1,
				weight: 1,
				enabled: true,
				last_resort: false,
			},
		],
		judge: { provider: "openai-credits", model: "gpt-4o" },
	},
};

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
});

async function settle() {
	await act(async () => {
		await Bun.sleep(30);
	});
}

async function mountEditing() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () =>
		root.render(
			<ProviderPoolsEditor
				disabled={false}
				modelMap={{}}
				onSave={() => Promise.resolve()}
				pools={POOLS}
				providers={PROVIDERS}
				supportedStrategies={["round_robin", "fusion"]}
			/>
		)
	);
	await act(async () =>
		document
			.querySelector<HTMLElement>('[aria-label="Edit pool donated"]')
			?.click()
	);
	await settle();
}

function trigger(id: string): HTMLElement {
	const element = document.getElementById(id);
	if (!element) {
		throw new Error(`Missing select trigger #${id}`);
	}
	return element;
}

/** What the closed control shows: its value text, without the chevron. */
function shown(element: HTMLElement | null | undefined): string {
	return (
		element?.querySelector('[data-slot="select-value"]')?.textContent?.trim() ??
		""
	);
}

async function optionLabels(id: string): Promise<string[]> {
	await act(async () => trigger(id).click());
	await settle();
	const labels = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].map((option) => option.textContent?.trim() ?? "");
	// Close the popup so the next dropdown opens from a clean document.
	await act(async () => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
		);
	});
	await settle();
	return labels;
}

test("a member's Provider dropdown names the donated OpenAI credits provider, not its raw id", async () => {
	await mountEditing();
	const memberTrigger = [
		...document.querySelectorAll<HTMLElement>('[id^="pool-provider-"]'),
	].at(1);
	// Member 2 is saved against `openai-credits`; the closed control must read
	// as the donated allowance, not as the id or as plain OpenAI.
	expect(shown(memberTrigger)).toBe(DONATED_LABEL);
	const firstId = document.querySelector('[id^="pool-provider-"]')?.id ?? "";
	const labels = await optionLabels(firstId);
	expect(labels).toEqual(["Anthropic", "OpenAI", DONATED_LABEL]);
});

test("the Judge provider dropdown names the donated OpenAI credits provider, not its raw id", async () => {
	await mountEditing();
	expect(shown(trigger("pool-judge-provider"))).toBe(DONATED_LABEL);
	const labels = await optionLabels("pool-judge-provider");
	expect(labels).toEqual(["Anthropic", "OpenAI", DONATED_LABEL]);
});
