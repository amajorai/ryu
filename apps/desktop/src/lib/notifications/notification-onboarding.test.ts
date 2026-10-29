import { describe, expect, test } from "bun:test";
import {
	detectDeviceOs,
	notificationOnboardingCopy,
} from "./notification-onboarding.ts";

describe("detectDeviceOs", () => {
	test("maps user agents to the settings screen family", () => {
		expect(detectDeviceOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)")).toBe(
			"macos"
		);
		expect(detectDeviceOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(
			"windows"
		);
		expect(
			detectDeviceOs("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")
		).toBe("ios");
		expect(detectDeviceOs("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe(
			"android"
		);
		expect(detectDeviceOs("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
	});
});

describe("notificationOnboardingCopy", () => {
	test("desktop points at the OS notification settings", () => {
		const mac = notificationOnboardingCopy({
			os: "macos",
			permission: "granted",
			platform: "desktop",
			surface: "desktop",
		});
		expect(mac.supported).toBe(true);
		expect(mac.blockedHelp).toContain("System Settings → Notifications");
		const windows = notificationOnboardingCopy({
			os: "windows",
			permission: "granted",
			platform: "desktop",
			surface: "desktop",
		});
		expect(windows.blockedHelp).toContain("Settings → System → Notifications");
	});

	test("the extension asks the browser for the extension permission", () => {
		const copy = notificationOnboardingCopy({
			os: "macos",
			permission: "default",
			platform: "extension",
			surface: "extension",
		});
		expect(copy.subtitle).toContain("Ryu extension");
		expect(copy.blockedHelp).toContain("extension settings");
	});

	test("web distinguishes phone browsers from desktop tabs", () => {
		const phone = notificationOnboardingCopy({
			os: "android",
			permission: "default",
			platform: "web",
			surface: "mobile",
		});
		expect(phone.subtitle).toContain("this phone");
		const desktopTab = notificationOnboardingCopy({
			os: "linux",
			permission: "denied",
			platform: "web",
			surface: "web",
		});
		expect(desktopTab.subtitle).toContain("close this tab");
		expect(desktopTab.blockedHelp).toContain("address bar");
	});

	test("iPhone Safari explains Add to Home Screen", () => {
		const copy = notificationOnboardingCopy({
			os: "ios",
			permission: "unsupported",
			platform: "unsupported",
			surface: "mobile",
		});
		expect(copy.supported).toBe(false);
		expect(copy.subtitle).toContain("Add to Home Screen");
	});

	test("Android browsers without notifications point to the mobile app", () => {
		const copy = notificationOnboardingCopy({
			os: "android",
			permission: "unsupported",
			platform: "unsupported",
			surface: "mobile",
		});
		expect(copy.supported).toBe(false);
		expect(copy.subtitle).toContain("Ryu mobile app");
	});

	test("Telegram explains replies arrive as messages", () => {
		const copy = notificationOnboardingCopy({
			os: "android",
			permission: "unsupported",
			platform: "unsupported",
			surface: "telegram",
		});
		expect(copy.subtitle).toContain("Telegram messages");
	});
});
