// Interface compliance, failure modes: a renderer that throws (every time), a
// renderer that never mounts, and a hostile renderer that opens a modal
// dialog, draws a full-window fixed overlay and swallows keys. The host must
// still give the user a way out of each. (Its own process: it replaces three
// renderer modules.)

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	builtinInterfaceId,
	type InterfaceDescriptor,
} from "@ryuhq/protocol/interfaces";
import { useEffect } from "react";
import { useProductModeStore } from "@/src/lib/product-mode.ts";
import {
	act,
	closeMenu,
	menuItem,
	mountSurface,
	openMenu,
	pressSwitchChord,
	settle,
} from "./interface-compliance-harness.tsx";

const toasts: string[] = [];
// After the harness has registered the DOM: Base UI reads it on load.
const { Dialog, DialogContent, DialogTitle } = await import(
	"@ryu/ui/components/dialog.tsx"
);

mock.module("@ryu/ui/components/sileo.tsx", () => ({
	toast: Object.assign((message: string) => toasts.push(message), {
		error: (message: string) => toasts.push(message),
		info: (message: string) => toasts.push(message),
		success: (message: string) => toasts.push(message),
		warning: (message: string) => toasts.push(message),
	}),
}));

function Throws(): never {
	throw new Error("fixture renderer failure");
}
mock.module("@ryu/blocks/desktop/interfaces/hub-interface.tsx", () => ({
	HubInterface: Throws,
}));

const never = new Promise<never>(() => undefined);
function NeverMounts(): never {
	throw never;
}
mock.module("@ryu/blocks/desktop/interfaces/moments-interface.tsx", () => ({
	MomentsInterface: NeverMounts,
}));

function Hostile() {
	useEffect(() => {
		const swallow = (event: KeyboardEvent) => {
			event.stopImmediatePropagation();
			event.preventDefault();
		};
		window.addEventListener("keydown", swallow, { capture: true });
		return () =>
			window.removeEventListener("keydown", swallow, { capture: true });
	}, []);
	return (
		<>
			<div
				data-testid="hostile-overlay"
				style={{ inset: 0, position: "fixed", zIndex: 2_147_483_647 }}
			/>
			<Dialog open>
				<DialogContent data-testid="hostile-dialog">
					<DialogTitle>Covering everything</DialogTitle>
				</DialogContent>
			</Dialog>
		</>
	);
}
mock.module("@ryu/blocks/desktop/interfaces/panels-interface.tsx", () => ({
	PanelsInterface: Hostile,
}));

const { configureInterfaceEscape } = await import("./interface-escape-keys.ts");
const { backToChat } = await import("./interface-switcher.ts");
const { BUILTIN_INTERFACES } = await import("./registry.ts");

function builtin(
	renderer: InterfaceDescriptor["renderer"]
): InterfaceDescriptor {
	const descriptor = BUILTIN_INTERFACES.find(
		(candidate) => candidate.id === builtinInterfaceId(renderer)
	);
	if (!descriptor) {
		throw new Error(`No built-in ${renderer}`);
	}
	return descriptor;
}

beforeEach(() => {
	toasts.length = 0;
	configureInterfaceEscape({
		binding: "Mod+Shift+U",
		enabled: true,
		interfaceShown: true,
		onBackToChat: () => backToChat(true),
	});
});

describe("interface failure modes", () => {
	test("a renderer that throws again after its retry is switched off", async () => {
		const view = await mountSurface(builtin("hub"));
		try {
			expect(toasts).toEqual(["Hub crashed and was switched off"]);
			expect(useProductModeStore.getState().requestedMode).toBe("console");
			// Until the shell moves on, the panel itself offers the way out.
			expect(
				view.box.querySelector('[data-testid="interface-error"]')?.textContent
			).toContain("Back to chat");
		} finally {
			await view.dispose();
		}
	});

	test("a renderer that never mounts offers Back to chat after 10 s", async () => {
		const view = await mountSurface(builtin("moments"));
		try {
			expect(
				view.box.querySelector('[data-testid="interface-slow"]')
			).toBeNull();
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10_100));
			});
			const slow = view.box.querySelector('[data-testid="interface-slow"]');
			const back = [...(slow?.querySelectorAll("button") ?? [])].find(
				(button) => button.textContent === "Back to chat"
			);
			expect(back).toBeDefined();
			await act(async () => back?.click());
			expect(useProductModeStore.getState().requestedMode).toBe("console");
		} finally {
			await view.dispose();
		}
	}, 30_000);

	test("a hostile renderer cannot cover the bar or swallow the chord", async () => {
		const view = await mountSurface(builtin("panels"));
		try {
			await settle();
			const dialog = document.body.querySelector(
				'[data-testid="hostile-dialog"]'
			);
			const overlay = document.body.querySelector(
				'[data-testid="hostile-overlay"]'
			);
			expect(dialog).not.toBeNull();
			// Its dialog portals into its own box, and its fixed overlay is
			// contained there too (the box is a paint containment root).
			expect(view.box.contains(dialog)).toBe(true);
			expect(view.box.contains(overlay)).toBe(true);
			expect(view.box.style.contain).toBe("paint");
			// The bar stays live: not inert, not hidden from assistive tech.
			expect(view.bar.closest("[inert]")).toBeNull();
			expect(view.bar.closest('[aria-hidden="true"]')).toBeNull();
			// The chord still opens the switcher, and Back to chat still works.
			await pressSwitchChord(document.body);
			expect(openMenu()).not.toBeNull();
			const back = menuItem("Back to chat");
			await act(async () => back?.click());
			expect(useProductModeStore.getState().requestedMode).toBe("console");
		} finally {
			await closeMenu();
			await view.dispose();
		}
	});

	test("holding Escape leaves the interface for the chat", async () => {
		const view = await mountSurface(builtin("panels"));
		try {
			useProductModeStore.setState({ requestedMode: "os" });
			await act(async () => {
				window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
				await new Promise((resolve) => setTimeout(resolve, 1100));
			});
			expect(useProductModeStore.getState().requestedMode).toBe("console");
			// A tap does not.
			useProductModeStore.setState({ requestedMode: "os" });
			await act(async () => {
				window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
				window.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape" }));
				await new Promise((resolve) => setTimeout(resolve, 1100));
			});
			expect(useProductModeStore.getState().requestedMode).toBe("os");
		} finally {
			await view.dispose();
		}
	});
});
