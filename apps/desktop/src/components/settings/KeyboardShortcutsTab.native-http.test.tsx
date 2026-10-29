import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { Node } from "@/src/store/useNodeStore.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter } = await import("react-router-dom");
const { HotkeysProvider } = await import("@ryu/hotkeys/react");
const { chordTokens } = await import("@ryu/hotkeys/chord");
const { AppSurfaceProvider } = await import(
	"@/src/contexts/app-surface-context.tsx"
);
const { DESKTOP_HOTKEYS } = await import("@/src/lib/hotkeys/actions.ts");
const { coreKvHotkeyStorage } = await import("@/src/lib/hotkeys/storage.ts");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { KeyboardShortcutsTab } = await import("./KeyboardShortcutsTab.tsx");

const node: Node = {
	name: "shortcuts-proof",
	url: "https://shortcuts.fixture:7980",
	token: "shortcuts-token",
	userJwt: null,
};
const KEYBINDINGS_PATH = "/api/preferences/keybindings";

interface Call {
	body: { value: string } | null;
	method: string;
	path: string;
}
const originalFetch = globalThis.fetch;
const originalNodes = useNodeStore.getState();
const roots: Root[] = [];
let calls: Call[] = [];
/** Core's stored `keybindings` preference value (JSON overrides map). */
let storedKeybindings: string | null = null;

function respond(call: Call): Response {
	if (call.path === KEYBINDINGS_PATH) {
		if (call.method === "PUT") {
			storedKeybindings = call.body?.value ?? null;
			return Response.json({ ok: true });
		}
		return storedKeybindings === null
			? Response.json({ error: "missing" }, { status: 404 })
			: Response.json({ key: "keybindings", value: storedKeybindings });
	}
	if (call.path === "/api/plugins") {
		return Response.json({ apps: [] });
	}
	if (call.path === "/api/plugins/contributions") {
		return Response.json({});
	}
	return Response.json({ error: "undeclared" }, { status: 404 });
}

beforeEach(() => {
	calls = [];
	storedKeybindings = null;
	queryClient.clear();
	useNodeStore.setState({
		nodes: [node],
		defaultNode: node.name,
		autoSelect: false,
	});
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(
				input instanceof Request ? input.url : String(input),
				"https://shortcuts.fixture:7980"
			);
			const call: Call = {
				path: url.pathname,
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			calls.push(call);
			return await Promise.resolve(respond(call));
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(async () => {
	await unmountAll();
	globalThis.fetch = originalFetch;
	queryClient.clear();
	useNodeStore.setState(originalNodes);
});

async function unmountAll() {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
}

async function settle() {
	await act(async () => {
		await Bun.sleep(10);
	});
}

async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<MemoryRouter>
					<HotkeysProvider
						registry={DESKTOP_HOTKEYS}
						storage={coreKvHotkeyStorage}
					>
						<AppSurfaceProvider surface="desktop">
							<KeyboardShortcutsTab />
						</AppSurfaceProvider>
					</HotkeysProvider>
				</MemoryRouter>
			</QueryClientProvider>
		)
	);
	await settle();
}

function byTestId(id: string): HTMLElement {
	const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	if (!element) {
		throw new Error(`Missing ${id}`);
	}
	return element;
}

function recorderKeys(actionId: string): string[] {
	return Array.from(
		byTestId(`shortcut-recorder-${actionId}`).querySelectorAll("kbd")
	).map((kbd) => kbd.textContent ?? "");
}

/** Text of the settings row that holds an action's recorder and its label. */
function rowText(actionId: string, label: string): string {
	let element: HTMLElement | null = byTestId(`shortcut-recorder-${actionId}`);
	while (element && !element.textContent?.includes(label)) {
		element = element.parentElement;
	}
	if (!element) {
		throw new Error(`Missing row for ${actionId}`);
	}
	return element.textContent ?? "";
}

async function record(actionId: string, init: KeyboardEventInit) {
	const recorder = byTestId(`shortcut-recorder-${actionId}`);
	await act(async () => {
		recorder.click();
	});
	if (!recorder.textContent?.includes("Press keys…")) {
		throw new Error(`Recorder for ${actionId} did not start capturing`);
	}
	await act(async () => {
		recorder.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
		);
	});
	await settle();
}

function savedOverrides(): Record<string, string | null>[] {
	return calls
		.filter((call) => call.method === "PUT" && call.path === KEYBINDINGS_PATH)
		.map((call) => JSON.parse(call.body?.value ?? "null"));
}

test("a recorded chord is saved to the keybindings preference and reloads after a remount", async () => {
	await mount();
	expect(recorderKeys("sidebar.toggle")).toEqual(chordTokens("Mod+B"));
	expect(
		byTestId("shortcut-reset-sidebar.toggle").hasAttribute("disabled")
	).toBe(true);

	await record("sidebar.toggle", { key: "y", ctrlKey: true, shiftKey: true });

	expect(savedOverrides()).toEqual([{ "sidebar.toggle": "Mod+Shift+Y" }]);
	expect(recorderKeys("sidebar.toggle")).toEqual(chordTokens("Mod+Shift+Y"));

	await unmountAll();
	await mount();
	expect(recorderKeys("sidebar.toggle")).toEqual(chordTokens("Mod+Shift+Y"));
	expect(
		byTestId("shortcut-reset-sidebar.toggle").hasAttribute("disabled")
	).toBe(false);
});

test("Escape cancels recording without saving anything", async () => {
	await mount();
	await record("sidebar.toggle", { key: "Escape" });

	expect(savedOverrides()).toEqual([]);
	expect(recorderKeys("sidebar.toggle")).toEqual(chordTokens("Mod+B"));
});

test("a chord already bound elsewhere is flagged on both rows", async () => {
	await mount();
	expect(rowText("sidebar.toggle", "Toggle Sidebar")).not.toContain(
		"Also bound to"
	);

	await record("sidebar.toggle", { key: "k", ctrlKey: true });

	expect(rowText("sidebar.toggle", "Toggle Sidebar")).toContain(
		"Also bound to Toggle Command Palette"
	);
	expect(rowText("command-palette.toggle", "Toggle Command Palette")).toContain(
		"Also bound to Toggle Sidebar"
	);
	// Live conflict detection: the edit stands (and is persisted) so the user
	// can resolve it by rebinding either row.
	expect(savedOverrides()).toEqual([{ "sidebar.toggle": "Mod+K" }]);

	await act(async () => {
		byTestId("shortcut-reset-sidebar.toggle").click();
	});
	await settle();
	expect(
		rowText("command-palette.toggle", "Toggle Command Palette")
	).not.toContain("Also bound to");
	expect(savedOverrides().at(-1)).toEqual({});
});

test("Reset all to defaults clears every stored override after confirmation", async () => {
	storedKeybindings = JSON.stringify({
		"sidebar.toggle": "Mod+Shift+Y",
		"tab.new": null,
	});
	await mount();
	expect(recorderKeys("sidebar.toggle")).toEqual(chordTokens("Mod+Shift+Y"));
	expect(byTestId("shortcut-recorder-tab.new").textContent).toBe("Unbound");

	await act(async () => {
		byTestId("keyboard-shortcuts-reset-all").click();
	});
	await settle();
	expect(savedOverrides()).toEqual([]);
	const confirm = Array.from(
		document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')
	).find((button) => button.textContent?.trim() === "Reset all to defaults");
	if (!confirm) {
		throw new Error("Missing reset-all confirmation");
	}
	await act(async () => {
		confirm.click();
	});
	await settle();

	expect(savedOverrides()).toEqual([{}]);
	expect(JSON.parse(storedKeybindings ?? "null")).toEqual({});
	expect(recorderKeys("sidebar.toggle")).toEqual(chordTokens("Mod+B"));
	expect(recorderKeys("tab.new")).toEqual(chordTokens("Mod+T"));
});
