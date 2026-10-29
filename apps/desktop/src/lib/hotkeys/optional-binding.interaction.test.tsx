import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	HotkeysProvider,
	type HotkeyStorage,
	useHotkey,
	useHotkeysAdmin,
	useOptionalHotkeyBinding,
} from "@ryu/hotkeys/react";
import type { HotkeyRegistry, Overrides } from "@ryu/hotkeys/registry";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (typeof document === "undefined") GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const registry: HotkeyRegistry = [
	{
		id: "approval.accept",
		label: "Accept",
		category: "Approval",
		defaultBinding: "Mod+Enter",
	},
];
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});
function Observer({ id = "approval.accept" }: { id?: string }) {
	const binding = useOptionalHotkeyBinding(id);
	return <output data-action={id}>{binding ?? "unbound"}</output>;
}
function Controls() {
	const admin = useHotkeysAdmin();
	return (
		<>
			<button onClick={() => admin.setOverride("approval.accept", "Mod+K")}>
				Rebind
			</button>
			<button onClick={() => admin.setOverride("approval.accept", null)}>
				Clear
			</button>
			<button onClick={() => admin.reset("approval.accept")}>Reset</button>
		</>
	);
}
async function click(label: string) {
	const button = Array.from(container.querySelectorAll("button")).find(
		(node) => node.textContent === label
	);
	if (!button) throw new Error(`Missing actual control ${label}`);
	await act(async () => button.click());
}
test("optional observer remains inert without provider and for unknown actions", async () => {
	await act(async () => root.render(<Observer />));
	expect(container.textContent).toBe("unbound");
	await act(async () =>
		root.render(
			<HotkeysProvider registry={registry}>
				<Observer id="missing.action" />
			</HotkeysProvider>
		)
	);
	expect(container.textContent).toBe("unbound");
});
test("mounted observer follows effective rebind clear and reset without mutating registry defaults", async () => {
	await act(async () =>
		root.render(
			<HotkeysProvider registry={registry}>
				<Observer />
				<Controls />
			</HotkeysProvider>
		)
	);
	expect(container.querySelector("output")?.textContent).toBe("Mod+Enter");
	await click("Rebind");
	expect(container.querySelector("output")?.textContent).toBe("Mod+K");
	await click("Clear");
	expect(container.querySelector("output")?.textContent).toBe("unbound");
	await click("Reset");
	expect(container.querySelector("output")?.textContent).toBe("Mod+Enter");
	expect(registry[0]?.defaultBinding).toBe("Mod+Enter");
});
test("persisted changes and provider removal update observers and release storage subscription", async () => {
	const subscription: { notify?: (next: Overrides) => void } = {};
	let unsubscribed = 0;
	const storage: HotkeyStorage = {
		load: async () => ({ "approval.accept": null }),
		save: async () => {},
		subscribe(callback) {
			subscription.notify = callback;
			return () => {
				unsubscribed++;
				delete subscription.notify;
			};
		},
	};
	await act(async () =>
		root.render(
			<HotkeysProvider registry={registry} storage={storage}>
				<Observer />
			</HotkeysProvider>
		)
	);
	expect(container.textContent).toBe("unbound");
	if (!subscription.notify)
		throw new Error("Expected genuine provider storage subscription");
	const change = subscription.notify;
	await act(async () => change({ "approval.accept": "Mod+K" }));
	expect(container.textContent).toBe("Mod+K");
	await act(async () => root.render(<Observer />));
	expect(container.textContent).toBe("unbound");
	expect(unsubscribed).toBe(1);
});
test("several optional observers cannot steal or duplicate the actual provider action handler", async () => {
	let calls = 0;
	function Handler() {
		useHotkey("approval.accept", () => {
			calls++;
		});
		return null;
	}
	await act(async () =>
		root.render(
			<HotkeysProvider registry={registry}>
				<Handler />
				<Observer />
				<Observer />
				<Controls />
			</HotkeysProvider>
		)
	);
	const fire = async (key: string) => {
		const event = new KeyboardEvent("keydown", {
			key,
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		await act(async () => document.body.dispatchEvent(event));
		return event.defaultPrevented;
	};
	expect(await fire("Enter")).toBe(true);
	expect(calls).toBe(1);
	await click("Rebind");
	expect(await fire("Enter")).toBe(false);
	expect(calls).toBe(1);
	expect(await fire("k")).toBe(true);
	expect(calls).toBe(2);
	await click("Clear");
	expect(await fire("k")).toBe(false);
	expect(calls).toBe(2);
});
