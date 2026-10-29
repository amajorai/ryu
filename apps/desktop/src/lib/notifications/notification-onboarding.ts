import type { AppSurface } from "@/src/contexts/app-surface-context.tsx";
import type {
	NotificationPlatform,
	OsNotificationPermission,
} from "./os-notify.ts";

export type DeviceOs = "macos" | "windows" | "ios" | "android" | "linux";

/** Coarse OS from the user agent, enough to name the right settings screen. */
export function detectDeviceOs(userAgent: string): DeviceOs {
	if (/iPhone|iPad|iPod/u.test(userAgent)) {
		return "ios";
	}
	if (/Android/u.test(userAgent)) {
		return "android";
	}
	if (userAgent.includes("Windows")) {
		return "windows";
	}
	if (userAgent.includes("Mac")) {
		return "macos";
	}
	return "linux";
}

export interface NotificationOnboardingContext {
	os: DeviceOs;
	permission: OsNotificationPermission;
	platform: NotificationPlatform;
	surface: AppSurface;
}

export interface NotificationOnboardingCopy {
	/** Shown when the grant is blocked; tells the user exactly where to undo it. */
	blockedHelp: string;
	/** Primary button label. */
	enableLabel: string;
	/** One line under the title, specific to where Ryu is running. */
	subtitle: string;
	/** False when this host cannot show notifications at all. */
	supported: boolean;
}

function desktopSettingsPath(os: DeviceOs): string {
	switch (os) {
		case "macos":
			return "System Settings → Notifications → Ryu";
		case "windows":
			return "Settings → System → Notifications → Ryu";
		default:
			return "your desktop's notification settings";
	}
}

/**
 * Platform-specific wording for the onboarding notifications step. The shell is
 * shared by the desktop app, the browser extension, and the web app (including
 * phone browsers), and each asks for — and blocks — notifications differently.
 */
export function notificationOnboardingCopy(
	context: NotificationOnboardingContext
): NotificationOnboardingCopy {
	const { os, platform, surface } = context;
	if (platform === "desktop") {
		return {
			supported: true,
			enableLabel: "Turn on notifications",
			subtitle:
				"Get a desktop notification with the agent's avatar when it replies, needs approval or finishes a run.",
			blockedHelp: `If no banner appears, allow Ryu in ${desktopSettingsPath(os)}.`,
		};
	}
	if (platform === "extension") {
		return {
			supported: true,
			enableLabel: "Allow notifications",
			subtitle:
				"Your browser will ask to let the Ryu extension show notifications, even when the Ryu tab is in the background.",
			blockedHelp:
				"Your browser declined. Allow notifications for the Ryu extension in your browser's extension settings, then try again.",
		};
	}
	if (platform === "web") {
		const onPhone = surface === "mobile" || os === "ios" || os === "android";
		return {
			supported: true,
			enableLabel: "Allow notifications",
			subtitle: onPhone
				? "Your browser will ask to let Ryu notify you on this phone when an agent replies."
				: "Your browser will ask to let Ryu notify you when an agent replies, even after you close this tab.",
			blockedHelp: onPhone
				? "Notifications are blocked for this site. Allow them in your browser's site settings, then try again."
				: "Notifications are blocked for this site. Click the icon beside the address bar, allow notifications, then try again.",
		};
	}
	if (surface === "telegram") {
		return {
			supported: false,
			enableLabel: "Allow notifications",
			subtitle:
				"Inside Telegram, your agents' replies arrive as Telegram messages, so there's nothing to turn on here.",
			blockedHelp: "",
		};
	}
	if (os === "ios") {
		return {
			supported: false,
			enableLabel: "Allow notifications",
			subtitle:
				"On iPhone and iPad, add Ryu to your Home Screen (Share → Add to Home Screen), open it from there, and turn on notifications. Or use the Ryu mobile app.",
			blockedHelp: "",
		};
	}
	if (os === "android" || surface === "mobile") {
		return {
			supported: false,
			enableLabel: "Allow notifications",
			subtitle:
				"This browser can't show notifications. Install the Ryu mobile app to get notifications with the agent's avatar on this phone.",
			blockedHelp: "",
		};
	}
	return {
		supported: false,
		enableLabel: "Allow notifications",
		subtitle:
			"This browser can't show notifications. You'll still see alerts inside Ryu.",
		blockedHelp: "",
	};
}
