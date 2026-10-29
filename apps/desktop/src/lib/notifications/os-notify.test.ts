import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

const { OS_NOTIFICATIONS_ENABLED_KEY, setOsNotificationsEnabled } =
	await import("./notification-preferences.ts");
const {
	getNotificationPlatform,
	osNotificationsEnabled,
	requestOsNotificationPermission,
	resetOsNotifyForTests,
	showOsNotification,
} = await import("./os-notify.ts");
const { resetTauriGateForTests } = await import("../tauri-ready.ts");
const { registerNativeCopyTranslator } = await import("../native-copy.ts");
const { resetNotificationServiceWorkerForTests } = await import(
	"./service-worker.ts"
);

interface ShownNotification {
	onclick: (() => void) | null;
	options: NotificationOptions;
	title: string;
}

let shown: ShownNotification[];
let permission: NotificationPermission;
const originalNotification = globalThis.Notification;

function installWebNotification(): void {
	class FakeNotification {
		static get permission() {
			return permission;
		}
		static requestPermission() {
			permission = "granted";
			return Promise.resolve(permission);
		}
		onclick: (() => void) | null = null;
		constructor(title: string, options: NotificationOptions) {
			const entry: ShownNotification = { title, options, onclick: null };
			shown.push(entry);
			// Route the instance's later `onclick` assignment into the record.
			Object.defineProperty(this, "onclick", {
				set: (handler: () => void) => {
					entry.onclick = handler;
				},
				get: () => entry.onclick,
			});
		}
		close() {
			return undefined;
		}
	}
	Reflect.set(globalThis, "Notification", FakeNotification);
}

beforeEach(() => {
	shown = [];
	permission = "default";
	localStorage.clear();
	resetOsNotifyForTests();
	resetTauriGateForTests();
	resetNotificationServiceWorkerForTests();
	installWebNotification();
});

afterEach(() => {
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	Reflect.deleteProperty(globalThis, "chrome");
	Reflect.set(globalThis, "Notification", originalNotification);
	localStorage.removeItem(OS_NOTIFICATIONS_ENABLED_KEY);
});

describe("web", () => {
	test("an existing grant counts as enabled until the user chooses", () => {
		expect(getNotificationPlatform()).toBe("web");
		expect(osNotificationsEnabled()).toBe(false);
		permission = "granted";
		expect(osNotificationsEnabled()).toBe(true);
		setOsNotificationsEnabled(false);
		expect(osNotificationsEnabled()).toBe(false);
	});

	test("never prompts, and stays silent while disabled", async () => {
		setOsNotificationsEnabled(true);
		await showOsNotification({ title: "Nova", body: "Done" });
		expect(shown).toHaveLength(0);
		expect(permission).toBe("default");
	});

	test("shows the notification and routes the click", async () => {
		permission = "granted";
		setOsNotificationsEnabled(true);
		let clicked = 0;
		await showOsNotification({
			title: "Nova",
			body: "Finished the report",
			tag: "run-1",
			sender: { id: "nova", name: "Nova", avatarGlyph: null },
			onClick: () => {
				clicked += 1;
			},
		});
		expect(shown).toHaveLength(1);
		expect(shown[0]?.title).toBe("Nova");
		expect(shown[0]?.options).toMatchObject({
			body: "Finished the report",
			tag: "run-1",
		});
		shown[0]?.onclick?.();
		expect(clicked).toBe(1);
	});

	function withUserAgent(value: string, run: () => void) {
		const descriptor = Object.getOwnPropertyDescriptor(navigator, "userAgent");
		Object.defineProperty(navigator, "userAgent", {
			configurable: true,
			value,
		});
		try {
			run();
		} finally {
			if (descriptor) {
				Object.defineProperty(navigator, "userAgent", descriptor);
			} else {
				Reflect.deleteProperty(navigator, "userAgent");
			}
		}
	}

	function fakeWorker() {
		const shown: Array<{ title: string; options: NotificationOptions }> = [];
		const registration = {
			active: {},
			showNotification: (title: string, options: NotificationOptions) => {
				shown.push({ title, options });
				return Promise.resolve();
			},
		} as unknown as ServiceWorkerRegistration;
		resetNotificationServiceWorkerForTests(registration);
		return shown;
	}

	test("phone browsers need the web app's service worker", () => {
		withUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile", () => {
			expect(getNotificationPlatform()).toBe("unsupported");
			fakeWorker();
			expect(getNotificationPlatform()).toBe("web");
		});
	});

	test("delivers through the service worker and routes its clicks", async () => {
		const listeners: Array<(event: MessageEvent) => void> = [];
		const containerDescriptor = Object.getOwnPropertyDescriptor(
			navigator,
			"serviceWorker"
		);
		Object.defineProperty(navigator, "serviceWorker", {
			configurable: true,
			value: {
				addEventListener: (
					_: string,
					listener: (event: MessageEvent) => void
				) => listeners.push(listener),
			},
		});
		try {
			const workerShown = fakeWorker();
			permission = "granted";
			setOsNotificationsEnabled(true);
			let clicked = 0;
			await showOsNotification({
				title: "Nova",
				body: "Done",
				tag: "run-9",
				onClick: () => {
					clicked += 1;
				},
			});
			expect(shown).toHaveLength(0);
			expect(workerShown).toHaveLength(1);
			expect(workerShown[0]?.options).toMatchObject({
				body: "Done",
				tag: "run-9",
				data: { ryuNotificationId: "run-9" },
			});
			for (const listener of listeners) {
				listener({
					data: { type: "ryu:notification-click", id: "run-9" },
				} as MessageEvent);
			}
			expect(clicked).toBe(1);
		} finally {
			if (containerDescriptor) {
				Object.defineProperty(navigator, "serviceWorker", containerDescriptor);
			} else {
				Reflect.deleteProperty(navigator, "serviceWorker");
			}
		}
	});

	test("asks for permission only when requested", async () => {
		expect(await requestOsNotificationPermission()).toBe("granted");
	});
});

describe("desktop", () => {
	test("sends the avatar image to the native command", async () => {
		const calls: Array<{ command: string; args: unknown }> = [];
		Object.assign(window, {
			__TAURI_INTERNALS__: {
				transformCallback: () => 1,
				invoke: (command: string, args: unknown) => {
					calls.push({ command, args });
					return Promise.resolve(command === "plugin:event|listen" ? 1 : null);
				},
			},
		});
		expect(getNotificationPlatform()).toBe("desktop");
		// Desktop keeps its always-on behaviour until the user chooses.
		expect(osNotificationsEnabled()).toBe(true);
		await showOsNotification({
			title: "Nova",
			body: "Finished",
			tag: "run-7",
		});
		const show = calls.find((call) => call.command === "show_os_notification");
		expect(show?.args).toEqual({
			input: {
				title: "Nova",
				body: "Finished",
				imagePngBase64: null,
				tag: "run-7",
			},
		});
		expect(shown).toHaveLength(0);
	});

	test("sends the localized title and body to the native command", async () => {
		const calls: Array<{ command: string; args: unknown }> = [];
		Object.assign(window, {
			__TAURI_INTERNALS__: {
				transformCallback: () => 1,
				invoke: (command: string, args: unknown) => {
					calls.push({ command, args });
					return Promise.resolve(command === "plugin:event|listen" ? 1 : null);
				},
			},
		});
		const dispose = registerNativeCopyTranslator((text) =>
			text === "Test complete" ? "Test terminé" : text
		);
		try {
			await showOsNotification({
				title: "Test complete",
				body: "Nova",
				tag: "run-8",
			});
		} finally {
			dispose();
		}
		const show = calls.find((call) => call.command === "show_os_notification");
		expect(show?.args).toEqual({
			input: {
				title: "Test terminé",
				body: "Nova",
				imagePngBase64: null,
				tag: "run-8",
			},
		});
	});

	test("an explicit off wins on desktop", async () => {
		const calls: string[] = [];
		Object.assign(window, {
			__TAURI_INTERNALS__: {
				transformCallback: () => 1,
				invoke: (command: string) => {
					calls.push(command);
					return Promise.resolve(null);
				},
			},
		});
		setOsNotificationsEnabled(false);
		await showOsNotification({ title: "Nova" });
		expect(calls).not.toContain("show_os_notification");
	});
});

describe("extension", () => {
	function installChrome(granted: boolean) {
		const created: Array<{ id: string; options: Record<string, unknown> }> = [];
		const clickListeners: Array<(id: string) => void> = [];
		let hasPermission = granted;
		Reflect.set(globalThis, "chrome", {
			runtime: {
				id: "ryu-extension",
				getURL: (path: string) => `chrome-extension://ryu${path}`,
			},
			permissions: {
				contains: () => Promise.resolve(hasPermission),
				request: () => {
					hasPermission = true;
					return Promise.resolve(true);
				},
			},
			notifications: {
				create: (id: string, options: Record<string, unknown>) => {
					created.push({ id, options });
					return Promise.resolve(id);
				},
				clear: () => Promise.resolve(true),
				onClicked: {
					addListener: (listener: (id: string) => void) => {
						clickListeners.push(listener);
					},
				},
			},
		});
		return { created, clickListeners };
	}

	test("uses chrome.notifications with the extension icon fallback", async () => {
		const { created, clickListeners } = installChrome(true);
		expect(getNotificationPlatform()).toBe("extension");
		setOsNotificationsEnabled(true);
		let clicked = false;
		await showOsNotification({
			title: "Nova needs your approval",
			body: "Send the email?",
			tag: "approval-1",
			onClick: () => {
				clicked = true;
			},
		});
		expect(created).toEqual([
			{
				id: "approval-1",
				options: {
					type: "basic",
					iconUrl: "chrome-extension://ryu/icon/128.png",
					title: "Nova needs your approval",
					message: "Send the email?",
					priority: 1,
				},
			},
		]);
		expect(shown).toHaveLength(0);
		for (const listener of clickListeners) {
			listener("approval-1");
		}
		await Bun.sleep(0);
		expect(clicked).toBe(true);
	});

	test("requests the optional extension permission", async () => {
		installChrome(false);
		expect(osNotificationsEnabled()).toBe(false);
		expect(await requestOsNotificationPermission()).toBe("granted");
	});
});
