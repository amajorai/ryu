// The shortcuts editor announces each edit as the set it was made on and the
// result, so settings sync can upload only what the user changed. An editor can
// hold a set that is not Core's (another window or account changed Core since
// it loaded); its whole saved set must never stand in for the edit.

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}

import type { Overrides } from "@ryu/hotkeys/registry";

let coreShortcuts: Overrides = {};
// Holds Core's write open, the way a slow or remote node does.
let coreWriteGate: Promise<void> | null = null;
mock.module("@/src/lib/api/preferences.ts", () => ({
	getKeybindings: () => Promise.resolve({ ...coreShortcuts }),
	setKeybindings: async (_target: unknown, overrides: Overrides) => {
		await coreWriteGate;
		coreShortcuts = { ...overrides };
	},
}));
mock.module("@/src/store/useNodeStore.ts", () => ({
	useNodeStore: {
		getState: () => ({
			getActiveNode: () => ({ token: null, url: "http://127.0.0.1:1" }),
		}),
		subscribe: () => () => undefined,
	},
}));

const { HotkeysProvider, useHotkeysAdmin } = await import("@ryu/hotkeys/react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { coreKvHotkeyStorage, KEYBINDINGS_EDIT_EVENT } = await import(
	"./storage.ts"
);
type KeybindingsEdit = import("./storage.ts").KeybindingsEdit;

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const registry = [
	{
		id: "approval.accept",
		label: "Accept",
		category: "Approval",
		defaultBinding: "Mod+Enter",
	},
];

function Controls() {
	const admin = useHotkeysAdmin();
	return (
		<>
			<button
				onClick={() => admin.setOverride("approval.accept", "Mod+K")}
				type="button"
			>
				Rebind
			</button>
			<button onClick={() => admin.resetAll()} type="button">
				Reset all
			</button>
		</>
	);
}

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let edits: KeybindingsEdit[] = [];
const recordEdit = (event: Event) => {
	if (event instanceof CustomEvent) {
		edits.push(event.detail as KeybindingsEdit);
	}
};

beforeEach(() => {
	coreShortcuts = {};
	coreWriteGate = null;
	edits = [];
	window.addEventListener(KEYBINDINGS_EDIT_EVENT, recordEdit);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	window.removeEventListener(KEYBINDINGS_EDIT_EVENT, recordEdit);
});

async function click(label: string): Promise<void> {
	const button = Array.from(container.querySelectorAll("button")).find(
		(node) => node.textContent === label
	);
	if (!button) {
		throw new Error(`Missing control ${label}`);
	}
	await act(async () => {
		button.click();
		await Bun.sleep(0);
	});
}

test("an editor holding another account's set announces only its own edit's base", async () => {
	// The editor loads B's override; then another window installs A's set into
	// Core without this window hearing of it.
	coreShortcuts = { "b.private": "Mod+B" };
	await act(async () => {
		root.render(
			<HotkeysProvider registry={registry} storage={coreKvHotkeyStorage}>
				<Controls />
			</HotkeysProvider>
		);
		await Bun.sleep(0);
	});
	coreShortcuts = { "a.cmd": "Mod+A" };

	await click("Rebind");
	// Core gets the editor's whole (stale) set, but the edit says what changed.
	expect(coreShortcuts).toEqual({
		"approval.accept": "Mod+K",
		"b.private": "Mod+B",
	});
	expect(edits).toEqual([
		{
			after: { "approval.accept": "Mod+K", "b.private": "Mod+B" },
			before: { "b.private": "Mod+B" },
		},
	]);

	await click("Reset all");
	expect(edits[1]).toEqual({
		after: {},
		before: { "approval.accept": "Mod+K", "b.private": "Mod+B" },
	});
});

test("an edit is announced when it is made, before Core's write returns", async () => {
	let release: () => void = () => undefined;
	coreWriteGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const saved = coreKvHotkeyStorage.save({ "a.cmd": "Mod+A" }, {});
	// An account switch can land here; the edit must already be attributed.
	expect(edits).toEqual([{ after: { "a.cmd": "Mod+A" }, before: {} }]);
	expect(coreShortcuts).toEqual({});
	release();
	await saved;
	expect(coreShortcuts).toEqual({ "a.cmd": "Mod+A" });
	expect(edits).toHaveLength(1);
});
