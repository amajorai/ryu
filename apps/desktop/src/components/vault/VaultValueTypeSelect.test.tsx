import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register before React and isolate this file from non-browser Bun suites.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { VaultValueTypeSelect } = await import("./VaultValueTypeSelect.tsx");

import type { VaultValueType } from "./vault-value-type.ts";

let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
});

async function mount(current: VaultValueType | null, value: VaultValueType) {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			createElement(VaultValueTypeSelect, {
				current,
				id: "type",
				onChange: () => undefined,
				value,
			})
		);
	});
	const trigger = document.getElementById("type");
	if (!trigger) {
		throw new Error("the type trigger did not render");
	}
	return trigger;
}

function isDisabled(trigger: HTMLElement): boolean {
	return (
		trigger.hasAttribute("disabled") ||
		trigger.getAttribute("aria-disabled") === "true" ||
		trigger.hasAttribute("data-disabled")
	);
}

describe("VaultValueTypeSelect", () => {
	test("describes the picked type and stays editable for an open value", async () => {
		const trigger = await mount("secret", "config");
		expect(isDisabled(trigger)).toBe(false);
		expect(document.body.textContent).toContain("Not sensitive");
	});

	test("locks a sealed value", async () => {
		const trigger = await mount("sealed", "sealed");
		expect(isDisabled(trigger)).toBe(true);
		expect(document.body.textContent).toContain("can't be unsealed");
	});
});
