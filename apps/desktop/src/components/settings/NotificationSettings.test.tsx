import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { OS_NOTIFICATIONS_ENABLED_KEY } = await import(
	"@/src/lib/notifications/notification-preferences.ts"
);
const { showOsNotification } = await import(
	"@/src/lib/notifications/os-notify.ts"
);
const { NotificationSettings } = await import("./NotificationSettings.tsx");

type Grant = "granted" | "default" | "denied";

/**
 * The browser Notifications API this page would see: a current grant and the
 * answer the permission prompt gives when the switch is clicked.
 */
class FakeNotification {
	static permission: Grant = "default";
	static promptAnswer: Grant = "granted";
	static prompts = 0;
	static shown: string[] = [];
	static requestPermission(): Promise<Grant> {
		FakeNotification.prompts += 1;
		FakeNotification.permission = FakeNotification.promptAnswer;
		return Promise.resolve(FakeNotification.promptAnswer);
	}
	constructor(title: string) {
		FakeNotification.shown.push(title);
	}
}

const originalNotification = Reflect.get(globalThis, "Notification");
const roots: Root[] = [];

beforeEach(() => {
	localStorage.clear();
	FakeNotification.permission = "default";
	FakeNotification.promptAnswer = "granted";
	FakeNotification.prompts = 0;
	FakeNotification.shown = [];
	Reflect.set(globalThis, "Notification", FakeNotification);
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	Reflect.set(globalThis, "Notification", originalNotification);
});

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await Promise.resolve();
		}
	});
}

async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(<NotificationSettings />));
	await flush();
	return root;
}

async function unmountAll() {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
}

function notificationSwitch(): HTMLElement {
	const element = document.querySelector<HTMLElement>(
		'[role="switch"][aria-label="Show notifications on this device"]'
	);
	if (!element) {
		throw new Error("Missing notifications switch");
	}
	return element;
}

function isChecked(element: HTMLElement): boolean {
	return element.getAttribute("aria-checked") === "true";
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
	await flush();
}

test("turning notifications on asks the browser and persists the choice across a remount", async () => {
	await mount();
	expect(isChecked(notificationSwitch())).toBe(false);
	expect(document.body.textContent).not.toContain("Send test notification");

	await click(notificationSwitch());

	expect(FakeNotification.prompts).toBe(1);
	expect(localStorage.getItem(OS_NOTIFICATIONS_ENABLED_KEY)).toBe("true");
	expect(isChecked(notificationSwitch())).toBe(true);
	const sendTest = Array.from(document.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === "Send test notification"
	);
	if (!sendTest) {
		throw new Error("Missing test notification button");
	}
	await click(sendTest);
	expect(FakeNotification.shown).toEqual(["Ryu"]);

	await unmountAll();
	await mount();
	expect(isChecked(notificationSwitch())).toBe(true);
	expect(FakeNotification.prompts).toBe(1);
});

test("a declined permission prompt is not saved as enabled and shows the blocked help", async () => {
	FakeNotification.promptAnswer = "denied";
	await mount();

	await click(notificationSwitch());

	expect(FakeNotification.prompts).toBe(1);
	expect(localStorage.getItem(OS_NOTIFICATIONS_ENABLED_KEY)).toBeNull();
	expect(isChecked(notificationSwitch())).toBe(false);
	expect(document.body.textContent).toContain("Blocked");
	expect(document.body.textContent).toContain(
		"Notifications are blocked for this site"
	);
});

test("turning notifications off persists false without prompting and survives a remount", async () => {
	FakeNotification.permission = "granted";
	await mount();
	// An existing grant with no explicit choice reads as on.
	expect(isChecked(notificationSwitch())).toBe(true);

	await click(notificationSwitch());

	expect(FakeNotification.prompts).toBe(0);
	expect(localStorage.getItem(OS_NOTIFICATIONS_ENABLED_KEY)).toBe("false");
	expect(isChecked(notificationSwitch())).toBe(false);
	// The choice takes effect: the browser grant alone no longer shows anything.
	await showOsNotification({ title: "Agent reply" });
	expect(FakeNotification.shown).toEqual([]);

	await unmountAll();
	await mount();
	expect(isChecked(notificationSwitch())).toBe(false);
	expect(document.body.textContent).not.toContain("Send test notification");
});

test("a host without any notification API shows the unsupported state with a disabled switch", async () => {
	Reflect.deleteProperty(globalThis, "Notification");
	await mount();

	const toggle = notificationSwitch();
	expect(
		toggle.hasAttribute("data-disabled") ||
			toggle.getAttribute("aria-disabled") === "true"
	).toBe(true);
	expect(document.body.textContent).toContain(
		"This browser can't show notifications"
	);

	await click(toggle);
	expect(localStorage.getItem(OS_NOTIFICATIONS_ENABLED_KEY)).toBeNull();
});
