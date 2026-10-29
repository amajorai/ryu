import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

// Control-level coverage for the shipping Settings → Keyboard Shortcuts →
// Clips quick attach section. The component, the production OS-permission
// helpers and the Layout's destination consumer (`clipsQuickAttachDestination
// FromStatus` + `resolveClipsQuickAttachTarget`) run unchanged; the only
// stand-in is the Tauri IPC bridge, answered here by a stateful model of the
// Rust commands in `src-tauri/src/clips_quick_attach/mod.rs`: enabling starts
// the listener before the config is saved, stopping clears the last error, and
// the destination is written straight to the config file. The OS keyboard hook
// itself needs macOS or Windows hardware and is not exercised here.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

type Destination = "automatic" | "current_chat" | "new_chat";

interface NativeCall {
	args: Record<string, unknown>;
	command: string;
}

interface ConfigFile {
	destination: Destination;
	enabled: boolean;
}

const MAC_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
const WINDOWS_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
const SWITCH = "Attach recent activity to a chat";
const DESTINATION = "Clips destination";
const HOOK_ERROR =
	"couldn't create the keyboard event tap — grant Input Monitoring to Ryu in System Settings › Privacy & Security, then restart the app";
const CAPTURE_ERROR = "Open a chat before using the Current chat destination.";

const native = {
	calls: [] as NativeCall[],
	disk: { destination: "automatic", enabled: false } as ConfigFile,
	error: null as string | null,
	failNextSave: false,
	held: null as null | (() => void),
	holdNextDestination: false,
	inputMonitoring: false,
	listening: false,
	supported: true,
	unexpected: [] as string[],
};

function status() {
	return {
		destination: native.disk.destination,
		enabled: native.disk.enabled,
		error: native.error,
		input_monitoring: native.inputMonitoring,
		listening: native.listening,
		supported: native.supported,
	};
}

function saveConfig(next: ConfigFile) {
	if (native.failNextSave) {
		native.failNextSave = false;
		throw new Error("Permission denied (os error 13)");
	}
	native.disk = { ...next };
}

async function nativeInvoke(
	command: string,
	args: Record<string, unknown> = {}
): Promise<unknown> {
	native.calls.push({ args: { ...args }, command });
	switch (command) {
		case "clips_quick_attach_status":
			return status();
		case "clips_quick_attach_set_enabled": {
			const enabled = args.enabled === true;
			if (enabled) {
				// Rust starts the listener first; only a live listener is saved.
				if (navigator.userAgent.includes("Mac") && !native.inputMonitoring) {
					throw new Error(HOOK_ERROR);
				}
				native.listening = true;
			} else {
				native.listening = false;
			}
			native.error = null;
			saveConfig({ ...native.disk, enabled });
			return status();
		}
		case "clips_quick_attach_set_destination": {
			if (native.holdNextDestination) {
				native.holdNextDestination = false;
				await new Promise<void>((resolve) => {
					native.held = resolve;
				});
			}
			const destination = args.destination;
			if (
				destination !== "automatic" &&
				destination !== "current_chat" &&
				destination !== "new_chat"
			) {
				native.unexpected.push(`invalid destination ${String(destination)}`);
				throw new Error("unknown variant");
			}
			saveConfig({ ...native.disk, destination });
			return status();
		}
		case "request_input_monitoring_permission":
			return false;
		case "open_privacy_settings":
			return null;
		default:
			native.unexpected.push(`Undeclared native command ${command}`);
			throw new Error(`Undeclared native command ${command}`);
	}
}

const userAgentDescriptor = Object.getOwnPropertyDescriptor(
	navigator,
	"userAgent"
);
function useUserAgent(value: string) {
	Object.defineProperty(navigator, "userAgent", {
		configurable: true,
		value,
	});
}
Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: nativeInvoke,
	transformCallback: () => 0,
});

const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { invokeWhenReady } = await import("@/src/lib/tauri-ready.ts");
const { clipsQuickAttachDestinationFromStatus, resolveClipsQuickAttachTarget } =
	await import("@/src/lib/clips-quick-attach.ts");
const { ClipsQuickAttachSettings } = await import(
	"./ClipsQuickAttachSettings.tsx"
);

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(async () => {
	useUserAgent(MAC_UA);
	native.calls.length = 0;
	native.disk = { destination: "automatic", enabled: false };
	native.error = null;
	native.failNextSave = false;
	native.held = null;
	native.holdNextDestination = false;
	native.inputMonitoring = false;
	native.listening = false;
	native.supported = true;
	native.unexpected.length = 0;
	localStorage.clear();
	localStorage.setItem("clips-quick-attach-coverage-unrelated", "kept");
	await act(async () => sileo.clear());
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	native.held?.();
	await unmount();
	await act(async () => sileo.clear());
	container.remove();
	document.body.replaceChildren();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave unrelated browser storage untouched.
	expect(localStorage.getItem("clips-quick-attach-coverage-unrelated")).toBe(
		"kept"
	);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case rejects undeclared native commands and invalid arguments.
	expect(native.unexpected).toEqual([]);
});

afterAll(() => {
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	if (userAgentDescriptor) {
		Object.defineProperty(navigator, "userAgent", userAgentDescriptor);
	} else {
		Reflect.deleteProperty(navigator, "userAgent");
	}
});

async function until(predicate: () => boolean, label: string) {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (predicate()) {
			return;
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	throw new Error(`${label} did not settle: ${document.body.textContent}`);
}

async function mount() {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<>
				<ClipsQuickAttachSettings />
				<Toaster position="bottom-right" />
			</>
		)
	);
	await until(
		() => container.querySelector(`[aria-label="${SWITCH}"]`) !== null,
		"Clips quick attach status"
	);
}

async function unmount() {
	if (root) {
		const mounted = root;
		await act(async () => mounted.unmount());
	}
	root = null;
}

async function remount() {
	await unmount();
	await mount();
}

function text(element: Element | null | undefined) {
	return element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function rowTitles() {
	return [...container.querySelectorAll('[data-slot="item-title"]')].map(
		(title) => text(title)
	);
}

function row(title: string): HTMLElement {
	const heading = [
		...container.querySelectorAll('[data-slot="item-title"]'),
	].find((candidate) => text(candidate) === title);
	const item = heading?.closest<HTMLElement>('[data-slot="item"]');
	if (!item) {
		throw new Error(`Missing row ${title}: ${rowTitles().join(" | ")}`);
	}
	return item;
}

function captionFor(title: string) {
	const card = row(title).closest('[data-slot="item-group"]');
	return text(card?.nextElementSibling);
}

function labelled(label: string): HTMLElement {
	const found = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
	if (!found) {
		throw new Error(`Missing control ${label}: ${text(container)}`);
	}
	return found;
}

function isChecked(element: HTMLElement) {
	return element.getAttribute("aria-checked") === "true";
}

function isDisabled(element: HTMLElement) {
	return (
		element.hasAttribute("disabled") ||
		element.getAttribute("aria-disabled") === "true" ||
		element.hasAttribute("data-disabled")
	);
}

function selectedDestination() {
	return text(
		labelled(DESTINATION).querySelector('[data-slot="select-value"]')
	);
}

/** The listbox of the one select that is open now (closed popups linger). */
function openOptions() {
	const listbox = [
		...document.querySelectorAll<HTMLElement>('[role="listbox"]'),
	]
		.filter(
			(box) =>
				!(box.hasAttribute("data-closed") || box.closest("[data-closed]"))
		)
		.at(-1);
	return [...(listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
}

async function chooseDestination(label: string) {
	await click(labelled(DESTINATION));
	await until(() => openOptions().length > 0, "destination options");
	const option = openOptions().find((candidate) =>
		text(candidate).startsWith(label)
	);
	if (!option) {
		throw new Error(`Missing destination option ${label}`);
	}
	await click(option);
	await until(
		() => labelled(DESTINATION).getAttribute("aria-expanded") === "false",
		"destination close"
	);
}

function commands(name?: string) {
	return native.calls
		.filter((call) => !name || call.command === name)
		.map((call) => ({ args: call.args, command: call.command }));
}

/** What Layout does when the gesture fires: read native status and resolve. */
async function consumerTarget(hasCurrentChat: boolean) {
	const destination = clipsQuickAttachDestinationFromStatus(
		await invokeWhenReady<unknown>("clips_quick_attach_status")
	);
	if (!destination) {
		throw new Error("Consumer could not read the saved destination");
	}
	return resolveClipsQuickAttachTarget(destination, hasCurrentChat);
}

async function returnToRyu() {
	await act(async () => {
		window.dispatchEvent(new Event("focus"));
	});
}

test("an unsupported platform disables both controls, keeps the saved destination visible and never writes", async () => {
	native.supported = false;
	native.disk = { destination: "new_chat", enabled: true };
	await mount();

	expect(text(container)).toContain(
		"Clips quick attach is supported on macOS and Windows."
	);
	expect(rowTitles()).toEqual([SWITCH, DESTINATION]);
	const attach = labelled(SWITCH);
	expect(attach.getAttribute("role")).toBe("switch");
	expect(isChecked(attach)).toBe(false);
	expect(isDisabled(attach)).toBe(true);
	const destination = labelled(DESTINATION);
	expect(isDisabled(destination)).toBe(true);
	expect(selectedDestination()).toBe("New chat");

	await click(attach);
	await click(destination);
	await act(async () => Bun.sleep(20));
	expect(openOptions()).toEqual([]);
	expect(isChecked(labelled(SWITCH))).toBe(false);
	expect(commands().map((call) => call.command)).toEqual([
		"clips_quick_attach_status",
	]);
	expect(native.disk).toEqual({ destination: "new_chat", enabled: true });
});

test("the attach switch starts the listener, persists, survives remount, then stops and persists", async () => {
	native.inputMonitoring = true;
	native.disk = { destination: "new_chat", enabled: false };
	await mount();
	expect(text(container)).toContain(
		"Press Command twice to attach recent activity. Ryu never sends it automatically."
	);
	expect(captionFor(SWITCH)).toBe(
		"Command twice captures the last three minutes as staged image attachments and a visible summary."
	);

	await click(labelled(SWITCH));
	await until(() => isChecked(labelled(SWITCH)), "attach on");
	expect(native.disk).toEqual({ destination: "new_chat", enabled: true });
	expect(native.listening).toBe(true);
	expect(text(document.body)).not.toContain("couldn't start");

	await remount();
	expect(isChecked(labelled(SWITCH))).toBe(true);
	expect(selectedDestination()).toBe("New chat");

	await click(labelled(SWITCH));
	await until(() => !isChecked(labelled(SWITCH)), "attach off");
	expect(native.disk).toEqual({ destination: "new_chat", enabled: false });
	expect(native.listening).toBe(false);
	expect(commands("clips_quick_attach_set_enabled")).toEqual([
		{ args: { enabled: true }, command: "clips_quick_attach_set_enabled" },
		{ args: { enabled: false }, command: "clips_quick_attach_set_enabled" },
	]);
	expect(commands("clips_quick_attach_set_destination")).toEqual([]);
	await remount();
	expect(isChecked(labelled(SWITCH))).toBe(false);
});

test("each destination is saved natively, locks the controls while saving, and drives the gesture consumer", async () => {
	native.inputMonitoring = true;
	native.disk = { destination: "automatic", enabled: true };
	native.listening = true;
	await mount();
	expect(selectedDestination()).toBe("Automatic");
	expect(await consumerTarget(false)).toBe("new_chat");

	native.holdNextDestination = true;
	await chooseDestination("Current chat");
	await until(() => native.held !== null, "held destination save");
	expect(isDisabled(labelled(SWITCH))).toBe(true);
	expect(isDisabled(labelled(DESTINATION))).toBe(true);
	await act(async () => native.held?.());
	await until(() => !isDisabled(labelled(DESTINATION)), "save settled");
	expect(selectedDestination()).toBe("Current chat");
	expect(native.disk).toEqual({ destination: "current_chat", enabled: true });
	// The gesture handler now refuses to guess when no chat is open.
	expect(await consumerTarget(false)).toBe("missing_current_chat");
	expect(await consumerTarget(true)).toBe("current_chat");

	await chooseDestination("New chat");
	await until(() => selectedDestination() === "New chat", "new chat");
	expect(await consumerTarget(true)).toBe("new_chat");

	await remount();
	expect(selectedDestination()).toBe("New chat");
	expect(isChecked(labelled(SWITCH))).toBe(true);
	expect(commands("clips_quick_attach_set_destination")).toEqual([
		{
			args: { destination: "current_chat" },
			command: "clips_quick_attach_set_destination",
		},
		{
			args: { destination: "new_chat" },
			command: "clips_quick_attach_set_destination",
		},
	]);
	expect(commands("clips_quick_attach_set_enabled")).toEqual([]);
});

test("a refused destination save reports it, keeps the saved choice and the switch, and a retry saves", async () => {
	native.inputMonitoring = true;
	native.disk = { destination: "automatic", enabled: true };
	native.listening = true;
	await mount();

	native.failNextSave = true;
	await chooseDestination("New chat");
	await until(
		() => text(document.body).includes("Couldn't save Clips destination"),
		"destination failure toast"
	);
	expect(text(document.body)).toContain("Permission denied (os error 13)");
	await until(() => selectedDestination() === "Automatic", "rolled back");
	expect(native.disk).toEqual({ destination: "automatic", enabled: true });
	expect(isChecked(labelled(SWITCH))).toBe(true);
	expect(isDisabled(labelled(DESTINATION))).toBe(false);
	expect(await consumerTarget(false)).toBe("new_chat");

	await chooseDestination("New chat");
	await until(() => selectedDestination() === "New chat", "retry saved");
	expect(native.disk).toEqual({ destination: "new_chat", enabled: true });
	expect(
		commands().filter((call) => call.command !== "clips_quick_attach_status")
	).toEqual([
		{
			args: { destination: "new_chat" },
			command: "clips_quick_attach_set_destination",
		},
		{
			args: { destination: "new_chat" },
			command: "clips_quick_attach_set_destination",
		},
	]);
});

test("macOS Input Monitoring Grant prompts and opens its pane; returning to Ryu shows the grant", async () => {
	await mount();
	expect(captionFor("Input Monitoring")).toBe(
		"Required on macOS so Ryu can recognize the double-Command gesture."
	);

	native.calls.length = 0;
	const grant = [...row("Input Monitoring").querySelectorAll("button")].find(
		(button) => text(button) === "Grant"
	);
	if (!grant) {
		throw new Error("Missing Grant button");
	}
	await click(grant);
	await until(
		() => commands("clips_quick_attach_status").length === 1,
		"status re-read after Grant"
	);
	expect(commands()).toEqual([
		{ args: {}, command: "request_input_monitoring_permission" },
		{
			args: { capability: "inputMonitoring" },
			command: "open_privacy_settings",
		},
		{ args: {}, command: "clips_quick_attach_status" },
	]);
	expect(text(row("Input Monitoring"))).toContain("Grant");

	native.inputMonitoring = true;
	await returnToRyu();
	await until(
		() => text(row("Input Monitoring")).includes("Granted"),
		"Input Monitoring granted"
	);
	expect(row("Input Monitoring").querySelectorAll("button").length).toBe(0);

	await unmount();
	const reads = commands("clips_quick_attach_status").length;
	await returnToRyu();
	await act(async () => Bun.sleep(20));
	expect(commands("clips_quick_attach_status").length).toBe(reads);
});

test("Windows uses the Alt gesture and shows no macOS permission row", async () => {
	useUserAgent(WINDOWS_UA);
	await mount();
	expect(text(container)).toContain(
		"Press Alt twice to attach recent activity."
	);
	expect(rowTitles()).toEqual([SWITCH, DESTINATION]);

	await click(labelled(SWITCH));
	await until(() => isChecked(labelled(SWITCH)), "attach on");
	expect(native.disk).toEqual({ destination: "automatic", enabled: true });
	expect(
		commands().some((call) => call.command.includes("input_monitoring"))
	).toBe(false);
});

test("Last Capture Failed shows the native error and disappears once quick attach stops", async () => {
	native.inputMonitoring = true;
	native.disk = { destination: "current_chat", enabled: true };
	native.listening = true;
	native.error = CAPTURE_ERROR;
	await mount();

	expect(rowTitles()).toContain("Last Capture Failed");
	expect(captionFor("Last Capture Failed")).toBe(CAPTURE_ERROR);

	await click(labelled(SWITCH));
	await until(
		() => !rowTitles().includes("Last Capture Failed"),
		"error row cleared"
	);
	expect(native.error).toBeNull();
	expect(native.disk).toEqual({ destination: "current_chat", enabled: false });
	expect(text(container)).not.toContain(CAPTURE_ERROR);
});

test("a refused start keeps the switch off, explains why and persists nothing", async () => {
	native.disk = { destination: "new_chat", enabled: false };
	await mount();

	await click(labelled(SWITCH));
	await until(
		() => text(document.body).includes("Clips quick attach couldn't start"),
		"start failure toast"
	);
	expect(text(document.body)).toContain(HOOK_ERROR);
	expect(isChecked(labelled(SWITCH))).toBe(false);
	expect(isDisabled(labelled(SWITCH))).toBe(false);
	expect(native.disk).toEqual({ destination: "new_chat", enabled: false });
	expect(selectedDestination()).toBe("New chat");
	expect(commands().map((call) => call.command)).toEqual([
		"clips_quick_attach_status",
		"clips_quick_attach_set_enabled",
		"clips_quick_attach_status",
	]);
});
