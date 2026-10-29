import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { GatewayComputerUseConfig } from "@/src/lib/api/gateway.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** What the Gateway's config read reports for `computer_use`. */
let computerUse: GatewayComputerUseConfig = { locked_use: false };
mock.module("@/src/lib/api/gateway.ts", () => ({
	fetchGatewayConfig: () => Promise.resolve({ computer_use: computerUse }),
	updateGatewayConfig: () => Promise.resolve(),
}));
const { createRoot } = await import("react-dom/client");
const { ComputerUseSettings } = await import("./ComputerUseSettings.tsx");

const roots: Root[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

async function render(): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<ComputerUseSettings
				canConfigure
				reachable
				target={{ url: "http://gateway.test:7980", token: null }}
			/>
		);
		await Promise.resolve();
	});
	return container;
}

function securityKeySwitch(container: HTMLElement): HTMLElement {
	const control = container.querySelector<HTMLElement>(
		'[aria-label="Allow hardware security key"]'
	);
	if (!control) {
		throw new Error("Missing security key switch");
	}
	return control;
}

function isDisabled(control: HTMLElement): boolean {
	return (
		control.hasAttribute("disabled") ||
		control.getAttribute("aria-disabled") === "true" ||
		control.hasAttribute("data-disabled")
	);
}

test("a Gateway that stores the field enables the security key switch", async () => {
	computerUse = { locked_use: false, security_key: false };
	const container = await render();
	expect(isDisabled(securityKeySwitch(container))).toBe(false);
	expect(container.textContent).toContain("No current feature uses");
});

test("a Gateway that predates the field disables the switch and says why", async () => {
	computerUse = { locked_use: false };
	const container = await render();
	expect(isDisabled(securityKeySwitch(container))).toBe(true);
	expect(container.textContent).toContain("too old to store this setting");
});
