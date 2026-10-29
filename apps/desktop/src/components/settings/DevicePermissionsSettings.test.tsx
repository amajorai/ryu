import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { DevicePermissionsSettings } = await import(
	"./DevicePermissionsSettings.tsx"
);
const checkCommands = [
	"check_screen_recording_permission",
	"check_accessibility_permission",
	"check_input_monitoring_permission",
];
interface PendingCheck {
	promise: Promise<boolean>;
	resolve: (value: boolean) => void;
	reject: (error: Error) => void;
}
function pendingCheck(): PendingCheck {
	let resolve!: (value: boolean) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<boolean>((accept, refuse) => {
		resolve = accept;
		reject = refuse;
	});
	return { promise, resolve, reject };
}
let calls: string[];
let batches: PendingCheck[][];
const roots: Root[] = [];
let bridgeDescriptor: PropertyDescriptor | undefined;
let userAgentDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
	calls = [];
	batches = Array.from({ length: 3 }, () =>
		checkCommands.map(() => pendingCheck())
	);
	bridgeDescriptor = Object.getOwnPropertyDescriptor(
		window,
		"__TAURI_INTERNALS__"
	);
	userAgentDescriptor = Object.getOwnPropertyDescriptor(navigator, "userAgent");
	Object.defineProperty(navigator, "userAgent", {
		configurable: true,
		value: "Macintosh",
	});
	Object.assign(window, {
		__TAURI_INTERNALS__: {
			transformCallback: () => 1,
			invoke: async (command: string) => {
				const checkIndex = checkCommands.indexOf(command);
				if (checkIndex === -1)
					throw new Error(`Unexpected native command: ${command}`);
				const batch = Math.floor(calls.length / checkCommands.length);
				calls.push(command);
				return await batches[batch][checkIndex].promise;
			},
		},
	});
});
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount();
	});
	document.body.replaceChildren();
	if (bridgeDescriptor)
		Object.defineProperty(window, "__TAURI_INTERNALS__", bridgeDescriptor);
	else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	if (userAgentDescriptor)
		Object.defineProperty(navigator, "userAgent", userAgentDescriptor);
	else Reflect.deleteProperty(navigator, "userAgent");
});
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
	await act(async () => root.render(<DevicePermissionsSettings />));
	await settle();
}
function statuses() {
	return [...document.querySelectorAll('[role="status"]')].map(
		(element) => element.textContent
	);
}
async function refresh() {
	await act(async () => window.dispatchEvent(new Event("focus")));
	await settle();
}
async function finish(batch: number, granted: boolean) {
	await act(async () => {
		for (const check of batches[batch]) check.resolve(granted);
	});
	await settle();
}
async function refuse(batch: number) {
	await act(async () => {
		batches[batch][0].reject(new Error("Native permission check failed"));
		for (const check of batches[batch].slice(1)) check.resolve(false);
	});
	await settle();
}
function alert() {
	return document.querySelector('[role="alert"]')?.textContent ?? null;
}
async function retry() {
	const button = [...document.querySelectorAll("button")].find(
		(element) => element.textContent === "Check access again"
	);
	if (!button) throw new Error("Missing native permission retry");
	await act(async () => button.click());
	await settle();
}

test("a late denied focus check cannot replace a newer native grant", async () => {
	await mount();
	expect(statuses()).toEqual(["Unchecked", "Unchecked", "Unchecked"]);
	await refresh();
	await finish(1, true);
	expect(statuses()).toEqual(["Granted", "Granted", "Granted"]);
	await finish(0, false);
	expect(statuses()).toEqual(["Granted", "Granted", "Granted"]);
	expect(
		[...document.querySelectorAll("button")].map((button) => button.textContent)
	).toEqual([
		"Enable microphone",
		"Open Screen Recording settings",
		"Open Accessibility settings",
		"Open Input Monitoring settings",
		"Check access again",
	]);
	expect(calls).toEqual([...checkCommands, ...checkCommands]);
});

test("a late native failure cannot erase a newer grant or expose a stale error", async () => {
	await mount();
	await refresh();
	await finish(1, true);
	await refuse(0);
	expect(statuses()).toEqual(["Granted", "Granted", "Granted"]);
	expect(alert()).toBeNull();
	expect(calls).toEqual([...checkCommands, ...checkCommands]);
});

test("a late grant cannot clear the latest native error and the current retry performs fresh checks", async () => {
	await mount();
	await refresh();
	await refuse(1);
	expect(statuses()).toEqual(["Unchecked", "Unchecked", "Unchecked"]);
	expect(alert()).toBe(
		"Couldn't check device access. Open this page in Ryu Desktop and retry."
	);
	await finish(0, true);
	expect(statuses()).toEqual(["Unchecked", "Unchecked", "Unchecked"]);
	expect(alert()).toBe(
		"Couldn't check device access. Open this page in Ryu Desktop and retry."
	);
	await retry();
	expect(calls).toEqual([...checkCommands, ...checkCommands, ...checkCommands]);
	await finish(2, true);
	expect(statuses()).toEqual(["Granted", "Granted", "Granted"]);
	expect(alert()).toBeNull();
});
