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
// Quick Capture section. The component and the production OS-permission
// helpers run unchanged; the only stand-in is the Tauri IPC bridge, which this
// file answers with a stateful model of the Rust commands in
// `src-tauri/src/quick_capture/mod.rs`: the config file persists only after the
// keyboard tap starts, disabling clears the last error, and the binding is
// written straight to the config file. The native tap and the macOS TCC
// prompts themselves need macOS hardware and are not exercised here.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(30_000);

type Binding = "either" | "left" | "right";

interface NativeCall {
	args: Record<string, unknown>;
	command: string;
}

/** What `quick-capture.json` holds on disk. */
interface ConfigFile {
	binding: Binding;
	enabled: boolean;
}

const TAP_ERROR =
	"couldn't create the keyboard event tap — grant Input Monitoring to Ryu in System Settings › Privacy & Security, then restart the app";
const QUESTS_OFF_ERROR =
	"the Quests app is turned off — enable it from the Store and try again";
const SWITCH = "Keep The Selection With A Double-Tap Of Shift";

const native = {
	accessibility: false,
	calls: [] as NativeCall[],
	disk: { binding: "either", enabled: false } as ConfigFile,
	error: null as string | null,
	failNextSave: false,
	held: null as null | (() => void),
	holdNextEnable: false,
	inputMonitoring: false,
	listening: false,
	questsEnabled: true,
	supported: true,
	unexpected: [] as string[],
};

function status() {
	return {
		accessibility: native.accessibility,
		binding: native.disk.binding,
		enabled: native.disk.enabled,
		error: native.error,
		input_monitoring: native.inputMonitoring,
		listening: native.listening,
		quests_enabled: native.questsEnabled,
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
		case "quick_capture_status":
			return status();
		case "quick_capture_set_enabled": {
			if (native.holdNextEnable) {
				native.holdNextEnable = false;
				await new Promise<void>((resolve) => {
					native.held = resolve;
				});
			}
			const enabled = args.enabled === true;
			if (enabled) {
				// Rust starts the tap FIRST and persists only on success.
				if (!native.inputMonitoring) {
					throw new Error(TAP_ERROR);
				}
				native.listening = true;
				native.error = null;
			} else {
				native.listening = false;
				native.error = null;
			}
			saveConfig({ ...native.disk, enabled });
			return status();
		}
		case "quick_capture_set_binding": {
			const binding = args.binding;
			if (binding !== "either" && binding !== "left" && binding !== "right") {
				native.unexpected.push(`invalid binding ${String(binding)}`);
				throw new Error("unknown variant");
			}
			saveConfig({ ...native.disk, binding });
			return status();
		}
		case "request_input_monitoring_permission":
		case "request_accessibility_permission":
			// The prompt only registers Ryu in System Settings; the grant itself
			// happens there, later, by the user.
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
Object.defineProperty(navigator, "userAgent", {
	configurable: true,
	value:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
});
Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: nativeInvoke,
	transformCallback: () => 0,
});

const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { QuickCaptureSettings } = await import("./QuickCaptureSettings.tsx");

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(async () => {
	native.accessibility = false;
	native.calls.length = 0;
	native.disk = { binding: "either", enabled: false };
	native.error = null;
	native.failNextSave = false;
	native.held = null;
	native.holdNextEnable = false;
	native.inputMonitoring = false;
	native.listening = false;
	native.questsEnabled = true;
	native.supported = true;
	native.unexpected.length = 0;
	localStorage.clear();
	localStorage.setItem("quick-capture-coverage-unrelated", "kept");
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
	expect(localStorage.getItem("quick-capture-coverage-unrelated")).toBe("kept");
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
				<QuickCaptureSettings />
				<Toaster position="bottom-right" />
			</>
		)
	);
	await until(
		() => container.textContent?.includes("Quick Capture") === true,
		"Quick Capture status"
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

/** The muted caption the settings group prints under the row with this title. */
function captionFor(title: string) {
	const card = row(title).closest('[data-slot="item-group"]');
	return text(card?.nextElementSibling);
}

function gestureSwitch(): HTMLElement {
	const found = container.querySelector<HTMLElement>(
		`[role="switch"][aria-label="${SWITCH}"]`
	);
	if (!found) {
		throw new Error(`Missing named switch: ${container.innerHTML}`);
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

function buttonIn(item: HTMLElement, label: string): HTMLButtonElement {
	const found = [...item.querySelectorAll("button")].find(
		(candidate) => text(candidate) === label
	);
	if (!found) {
		throw new Error(`Missing ${label} button in ${text(item)}`);
	}
	return found;
}

function bindingButton(label: string) {
	return buttonIn(row("Which Shift"), label);
}

function pressedBindings() {
	return [...row("Which Shift").querySelectorAll("button")]
		.filter((candidate) => candidate.getAttribute("aria-pressed") === "true")
		.map((candidate) => text(candidate));
}

function commands(name?: string) {
	return native.calls
		.filter((call) => !name || call.command === name)
		.map((call) => ({ args: call.args, command: call.command }));
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
}

async function returnToRyu() {
	await act(async () => {
		window.dispatchEvent(new Event("focus"));
	});
}

test("an unsupported platform shows a disabled, named, unchecked switch and never writes", async () => {
	native.supported = false;
	// Even a config file that says "on" must not render a lying switch.
	native.disk = { binding: "right", enabled: true };
	await mount();

	expect(text(container)).toContain("Quick Capture is macOS-only for now.");
	const control = gestureSwitch();
	expect(isChecked(control)).toBe(false);
	expect(isDisabled(control)).toBe(true);
	expect(rowTitles()).toEqual([SWITCH]);

	await click(control);
	await act(async () => Bun.sleep(20));
	expect(isChecked(gestureSwitch())).toBe(false);
	expect(commands().map((call) => call.command)).toEqual([
		"quick_capture_status",
	]);
	expect(native.disk).toEqual({ binding: "right", enabled: true });
});

test("the gesture switch starts the tap, persists, survives remount, then turns off and persists", async () => {
	native.inputMonitoring = true;
	native.accessibility = true;
	native.disk = { binding: "right", enabled: false };
	native.holdNextEnable = true;
	await mount();
	expect(isChecked(gestureSwitch())).toBe(false);

	await click(gestureSwitch());
	await until(() => native.held !== null, "held enable");
	// While the native call is in flight the switch cannot be toggled again.
	expect(isDisabled(gestureSwitch())).toBe(true);
	await act(async () => native.held?.());
	await until(() => isChecked(gestureSwitch()), "switch checked");
	expect(isDisabled(gestureSwitch())).toBe(false);
	expect(native.disk).toEqual({ binding: "right", enabled: true });
	expect(native.listening).toBe(true);
	expect(commands("quick_capture_set_enabled")).toEqual([
		{ args: { enabled: true }, command: "quick_capture_set_enabled" },
	]);
	expect(text(document.body)).not.toContain("Quick Capture couldn't start");

	await remount();
	expect(isChecked(gestureSwitch())).toBe(true);
	expect(pressedBindings()).toEqual(["Right only"]);

	await click(gestureSwitch());
	await until(() => !isChecked(gestureSwitch()), "switch unchecked");
	expect(native.disk).toEqual({ binding: "right", enabled: false });
	expect(native.listening).toBe(false);
	expect(commands("quick_capture_set_enabled")).toEqual([
		{ args: { enabled: true }, command: "quick_capture_set_enabled" },
		{ args: { enabled: false }, command: "quick_capture_set_enabled" },
	]);
	await remount();
	expect(isChecked(gestureSwitch())).toBe(false);
});

test("a refused start keeps the switch off, explains why, persists nothing, and retries after the grant", async () => {
	native.accessibility = true;
	await mount();

	await click(gestureSwitch());
	await until(
		() => text(document.body).includes("Quick Capture couldn't start"),
		"start failure toast"
	);
	expect(text(document.body)).toContain(TAP_ERROR);
	expect(isChecked(gestureSwitch())).toBe(false);
	expect(isDisabled(gestureSwitch())).toBe(false);
	expect(native.disk).toEqual({ binding: "either", enabled: false });
	// The failure re-reads native status so the row reports the truth.
	expect(commands().map((call) => call.command)).toEqual([
		"quick_capture_status",
		"quick_capture_set_enabled",
		"quick_capture_status",
	]);

	// The user grants Input Monitoring in System Settings and comes back.
	native.inputMonitoring = true;
	await returnToRyu();
	await until(
		() => text(row("Input Monitoring")).includes("Granted"),
		"granted"
	);
	await click(gestureSwitch());
	await until(() => isChecked(gestureSwitch()), "switch checked on retry");
	expect(native.disk).toEqual({ binding: "either", enabled: true });
	expect(commands("quick_capture_set_enabled")).toEqual([
		{ args: { enabled: true }, command: "quick_capture_set_enabled" },
		{ args: { enabled: true }, command: "quick_capture_set_enabled" },
	]);
});

test("Which Shift saves the chosen side, exposes the selection, keeps it on refusal and after remount", async () => {
	native.inputMonitoring = true;
	native.accessibility = true;
	native.disk = { binding: "either", enabled: true };
	native.listening = true;
	await mount();

	expect(captionFor("Which Shift")).toBe(
		"Bind to one side if you use the other Shift heavily."
	);
	expect(pressedBindings()).toEqual(["Either Shift"]);

	await click(bindingButton("Left only"));
	await until(() => pressedBindings()[0] === "Left only", "left pressed");
	expect(pressedBindings()).toEqual(["Left only"]);
	expect(native.disk).toEqual({ binding: "left", enabled: true });

	native.failNextSave = true;
	await click(bindingButton("Right only"));
	await until(
		() => commands("quick_capture_status").length >= 2,
		"refresh after refusal"
	);
	expect(pressedBindings()).toEqual(["Left only"]);
	expect(native.disk).toEqual({ binding: "left", enabled: true });
	// The unrelated gesture switch is untouched by the binding failure.
	expect(isChecked(gestureSwitch())).toBe(true);

	await remount();
	expect(pressedBindings()).toEqual(["Left only"]);
	expect(commands("quick_capture_set_binding")).toEqual([
		{ args: { binding: "left" }, command: "quick_capture_set_binding" },
		{ args: { binding: "right" }, command: "quick_capture_set_binding" },
	]);
	expect(commands("quick_capture_set_enabled")).toEqual([]);
});

test("Input Monitoring Grant prompts, opens its pane, and returning to Ryu shows the grant", async () => {
	native.accessibility = true;
	await mount();

	const inputMonitoring = row("Input Monitoring");
	expect(captionFor("Input Monitoring")).toBe(
		"Required. The gesture can't be detected without it."
	);
	native.calls.length = 0;
	await click(buttonIn(inputMonitoring, "Grant"));
	await until(
		() => commands("quick_capture_status").length === 1,
		"status re-read after Grant"
	);
	expect(commands()).toEqual([
		{ args: {}, command: "request_input_monitoring_permission" },
		{
			args: { capability: "inputMonitoring" },
			command: "open_privacy_settings",
		},
		{ args: {}, command: "quick_capture_status" },
	]);
	// Not granted yet: the user still has to flip the switch in System Settings.
	expect(text(row("Input Monitoring"))).toContain("Grant");

	native.inputMonitoring = true;
	await returnToRyu();
	await until(
		() => text(row("Input Monitoring")).includes("Granted"),
		"Input Monitoring granted"
	);
	expect(
		[...row("Input Monitoring").querySelectorAll("button")].map((button) =>
			text(button)
		)
	).toEqual([]);
	expect(native.disk).toEqual({ binding: "either", enabled: false });

	// Unmounting removes the focus listener: no status read after it.
	await unmount();
	const reads = commands("quick_capture_status").length;
	await returnToRyu();
	await act(async () => Bun.sleep(20));
	expect(commands("quick_capture_status").length).toBe(reads);
});

test("Accessibility explains that it is optional and its Grant opens the Accessibility pane", async () => {
	native.inputMonitoring = true;
	await mount();

	const caption = captionFor("Accessibility");
	expect(caption).toContain(
		"Optional. Captures still work and still record which app they came from; without it they lose the window title and page URL."
	);
	expect(caption).toContain(
		"A freshly granted permission takes effect after Ryu restarts."
	);
	expect(text(row("Input Monitoring"))).toContain("Granted");

	native.calls.length = 0;
	await click(buttonIn(row("Accessibility"), "Grant"));
	await until(
		() => commands("quick_capture_status").length === 1,
		"status re-read after Accessibility Grant"
	);
	expect(commands()).toEqual([
		{ args: {}, command: "request_accessibility_permission" },
		{
			args: { capability: "accessibility" },
			command: "open_privacy_settings",
		},
		{ args: {}, command: "quick_capture_status" },
	]);

	native.accessibility = true;
	await returnToRyu();
	await until(
		() => text(row("Accessibility")).includes("Granted"),
		"Accessibility granted"
	);
});

test("Last Capture Failed shows the native error and disappears once the listener is stopped", async () => {
	native.inputMonitoring = true;
	native.accessibility = true;
	native.disk = { binding: "either", enabled: true };
	native.listening = true;
	native.error = QUESTS_OFF_ERROR;
	await mount();

	expect(rowTitles()).toContain("Last Capture Failed");
	expect(captionFor("Last Capture Failed")).toBe(QUESTS_OFF_ERROR);

	await click(gestureSwitch());
	await until(
		() => !rowTitles().includes("Last Capture Failed"),
		"error row cleared"
	);
	expect(native.error).toBeNull();
	expect(native.disk).toEqual({ binding: "either", enabled: false });
	expect(text(container)).not.toContain(QUESTS_OFF_ERROR);
});

test("Quests App reports Off with the Store hint and On after Quests is enabled", async () => {
	native.inputMonitoring = true;
	native.accessibility = true;
	native.questsEnabled = false;
	await mount();

	expect(text(row("Quests App"))).toContain("Off");
	expect(captionFor("Quests App")).toBe(
		"Captures have nowhere to go until Quests is enabled. Turn it on from the Store."
	);

	// The user enables Quests from the Store and returns to Ryu.
	native.questsEnabled = true;
	await returnToRyu();
	await until(() => text(row("Quests App")).includes("On"), "Quests on");
	expect(text(row("Quests App"))).not.toContain("Off");
	expect(text(container)).not.toContain("Captures have nowhere to go");
	expect(commands().map((call) => call.command)).toEqual([
		"quick_capture_status",
		"quick_capture_status",
	]);
});
