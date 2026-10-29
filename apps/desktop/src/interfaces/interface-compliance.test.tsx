// Interface compliance: every interface, built-in or from the Marketplace,
// must leave the user a way out. For each one mounted in the real
// InterfaceSurface: the switcher button is visible and focusable, the Switch
// Interface chord opens the menu even when the interface swallows keys,
// Back to chat works, and the interface cannot overlay the top bar.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	type InterfaceDescriptor,
	interfaceTier,
} from "@ryuhq/protocol/interfaces";
import { useProductModeStore } from "@/src/lib/product-mode.ts";
import {
	act,
	activate,
	closeMenu,
	menuItem,
	mountSurface,
	openMenu,
	pressSwitchChord,
	settle,
} from "./interface-compliance-harness.tsx";
import { configureInterfaceEscape } from "./interface-escape-keys.ts";
import { backToChat } from "./interface-switcher.ts";
import {
	BUILTIN_INTERFACES,
	OS_INTERFACE,
	resolveActiveInterface,
} from "./registry.ts";

/** A Marketplace entry with junk params, a long label and an unknown key. */
const MALFORMED: InterfaceDescriptor = {
	description: "",
	id: "@fixture/broken:night",
	label: "A Marketplace interface with a long, unwieldy name",
	origin: "marketplace",
	params: { camera: 7, junk: true, theme: "lava" },
	plugin: "@fixture/broken",
	renderer: "world-3d",
};

/** Every interface InterfaceSurface draws (the OS desktop is its own shell). */
const CASES: InterfaceDescriptor[] = [
	...BUILTIN_INTERFACES.filter(
		(descriptor) =>
			interfaceTier(descriptor.renderer) === "workspace" &&
			descriptor.renderer !== "os"
	),
	MALFORMED,
];

/** A hostile interface: swallows every key at the window, capture phase. */
function swallowKeys(event: KeyboardEvent) {
	event.stopImmediatePropagation();
	event.stopPropagation();
}

beforeAll(() => {
	configureInterfaceEscape({
		binding: "Mod+Shift+U",
		enabled: true,
		interfaceShown: true,
		onBackToChat: () => backToChat(true),
	});
	// Registered after the host's own listener, as any renderer's would be.
	window.addEventListener("keydown", swallowKeys, { capture: true });
	document.addEventListener("keydown", swallowKeys, { capture: true });
});

afterAll(() => {
	window.removeEventListener("keydown", swallowKeys, { capture: true });
	document.removeEventListener("keydown", swallowKeys, { capture: true });
});

describe("every interface leaves a way out", () => {
	test("the suite covers every built-in interface and a malformed one", () => {
		expect(CASES.length).toBeGreaterThan(60);
		expect(CASES.map((descriptor) => descriptor.renderer)).toContain("kitchen");
	});

	test("a remembered interface that is gone falls back to the default", () => {
		for (const workspaceInterfaceId of [
			"@uninstalled/plugin:town",
			"ryu:not-a-renderer",
			"",
		]) {
			expect(
				resolveActiveInterface({
					contributed: [],
					productMode: "os",
					workspaceInterfaceId,
					workspaceInterfaces: true,
				})
			).toBe(OS_INTERFACE);
		}
	});

	for (const descriptor of CASES) {
		test(`${descriptor.label} (${descriptor.renderer})`, async () => {
			const view = await mountSurface(descriptor);
			try {
				// The bar is the host's: outside the renderer's box, above it.
				expect(view.box.contains(view.bar)).toBe(false);
				expect(view.bar.className).toContain("z-30");
				expect(view.box.className).toContain("isolate");
				expect(view.box.className).toContain("overflow-clip");
				expect(view.box.style.contain).toBe("paint");
				// Anything the renderer portalled while mounting stays in its box.
				for (const portal of document.body.querySelectorAll(
					"[data-base-ui-portal], [data-slot$='-portal']"
				)) {
					expect(view.box.contains(portal)).toBe(true);
				}

				// The switcher is visible, named, and takes focus.
				expect(view.switcher.closest("[inert]")).toBeNull();
				expect(view.switcher.getAttribute("title")).toBe("Switch interface");
				expect(view.switcher.textContent).toContain(
					descriptor.label.slice(0, 12)
				);
				act(() => view.switcher.focus());
				expect(document.activeElement).toBe(view.switcher);

				// The chord opens the menu even though the interface swallows keys.
				const inside =
					view.box.querySelector<HTMLElement>("button, [tabindex]") ?? view.box;
				await pressSwitchChord(inside);
				expect(openMenu()).not.toBeNull();

				// Back to chat leaves for the default chat.
				const back = menuItem("Back to chat");
				expect(back).toBeDefined();
				await act(async () => back?.click());
				expect(useProductModeStore.getState().requestedMode).toBe("console");
			} finally {
				await closeMenu();
				await view.dispose();
				await settle(1);
				activate(descriptor);
			}
		}, 30_000);
	}
});
