// apps/desktop/src/lib/os/permissions.ts
//
// Deep-links to the host OS privacy settings for a given capability. These are
// the escape hatch for the one prompt we cannot suppress: when the OS-level
// switch is off, navigator.mediaDevices.getUserMedia() throws NotAllowedError
// with no recoverable in-app dialog, so the only fix is to send the user to the
// right settings pane.
//
// On Windows both the webview permission and the OS microphone privacy settings
// can block access. On macOS the
// one-time TCC prompt fires from the bundle's NSMicrophoneUsageDescription, and a
// prior denial is only reversible from System Settings.

import { invokeWhenReady } from "../tauri-ready.ts";

type OsKind = "windows" | "macos" | "other";

function detectOs(): OsKind {
	const ua = navigator.userAgent;
	if (ua.includes("Windows")) {
		return "windows";
	}
	if (ua.includes("Mac")) {
		return "macos";
	}
	return "other";
}

const MIC_SETTINGS_URI = {
	windows: "ms-settings:privacy-microphone",
	macos:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
	other: null,
} satisfies Record<OsKind, string | null>;

/** Whether a microphone settings deep-link exists for the current OS. */
export function canOpenMicrophoneSettings(): boolean {
	return MIC_SETTINGS_URI[detectOs()] !== null;
}

/**
 * Open the OS microphone-privacy settings pane. Returns false when no deep-link
 * is known for the platform (e.g. Linux) or the shell open fails — callers
 * should fall back to a plain "open your system settings" instruction.
 */
export async function openMicrophoneSettings(): Promise<boolean> {
	const uri = MIC_SETTINGS_URI[detectOs()];
	if (!uri) {
		return false;
	}
	try {
		await invokeWhenReady("open_privacy_settings", {
			capability: "microphone",
		});
		return true;
	} catch {
		return false;
	}
}

const NOTIFICATION_SETTINGS_URI = {
	windows: "ms-settings:notifications",
	macos: "x-apple.systempreferences:com.apple.preference.notifications",
	other: null,
} satisfies Record<OsKind, string | null>;

/** Whether a notification settings deep-link exists for the current OS. */
export function canOpenNotificationSettings(): boolean {
	return NOTIFICATION_SETTINGS_URI[detectOs()] !== null;
}

/**
 * Open the OS notification settings pane (desktop app only). Desktop OSes never
 * tell an app it was muted, so this is how a user fixes missing banners.
 */
export async function openNotificationSettings(): Promise<boolean> {
	if (!NOTIFICATION_SETTINGS_URI[detectOs()]) {
		return false;
	}
	try {
		await invokeWhenReady("open_privacy_settings", {
			capability: "notifications",
		});
		return true;
	} catch {
		return false;
	}
}

// ── Automation permissions (Ghost): Accessibility + Screen Recording ──────────
//
// These gate the automation stack (the Ghost sidecar drives other apps via the
// accessibility tree and captures the screen for visual grounding). The grant is
// made by the signed desktop app, which sits at the top of the app → Core →
// ghost spawn chain, so macOS attributes it down to the sidecar's captures.
//
// `check*` never prompts (safe to poll on a settings screen); `request*` fires
// the one-time system prompt and registers the app in System Settings. A fresh
// grant may require restarting the app. Windows has no equivalent toggles;
// Linux reports session and input-device availability instead.

const ACCESSIBILITY_SETTINGS_URI = {
	windows: null,
	macos:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
	other: null,
} satisfies Record<OsKind, string | null>;

const SCREEN_RECORDING_SETTINGS_URI = {
	windows: null,
	macos:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
	other: null,
} satisfies Record<OsKind, string | null>;

const INPUT_MONITORING_SETTINGS_URI = {
	windows: null,
	macos:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
	other: null,
} satisfies Record<OsKind, string | null>;

/** Whether Accessibility is currently granted. Never prompts. */
export async function checkAccessibilityPermission(): Promise<boolean> {
	try {
		return await invokeWhenReady<boolean>("check_accessibility_permission");
	} catch {
		return false;
	}
}

/** Whether Screen Recording is currently granted. Never prompts. */
export async function checkScreenRecordingPermission(): Promise<boolean> {
	try {
		return await invokeWhenReady<boolean>("check_screen_recording_permission");
	} catch {
		return false;
	}
}

/**
 * Surface the macOS Accessibility prompt and register the app in System
 * Settings. Returns whether it is already granted; a fresh grant applies only
 * after the app restarts.
 */
export async function requestAccessibilityPermission(): Promise<boolean> {
	try {
		return await invokeWhenReady<boolean>("request_accessibility_permission");
	} catch {
		return false;
	}
}

/**
 * Surface the macOS Screen Recording prompt and register the app in System
 * Settings. Returns whether it is already granted; a fresh grant applies only
 * after the app restarts.
 */
export async function requestScreenRecordingPermission(): Promise<boolean> {
	try {
		return await invokeWhenReady<boolean>(
			"request_screen_recording_permission"
		);
	} catch {
		return false;
	}
}

/** Open the OS Accessibility-privacy settings pane. False when unsupported. */
export async function openAccessibilitySettings(): Promise<boolean> {
	const uri = ACCESSIBILITY_SETTINGS_URI[detectOs()];
	if (!uri) {
		return false;
	}
	try {
		await invokeWhenReady("open_privacy_settings", {
			capability: "accessibility",
		});
		return true;
	} catch {
		return false;
	}
}

/** Open the OS Screen-Recording-privacy settings pane. False when unsupported. */
export async function openScreenRecordingSettings(): Promise<boolean> {
	const uri = SCREEN_RECORDING_SETTINGS_URI[detectOs()];
	if (!uri) {
		return false;
	}
	try {
		await invokeWhenReady("open_privacy_settings", {
			capability: "screenRecording",
		});
		return true;
	} catch {
		return false;
	}
}

/** Whether Input Monitoring is currently granted. Never prompts. */
export async function checkInputMonitoringPermission(): Promise<boolean> {
	try {
		return await invokeWhenReady<boolean>("check_input_monitoring_permission");
	} catch {
		return false;
	}
}

/**
 * Surface the macOS Input Monitoring prompt and register the app in System
 * Settings. Returns whether it is already granted; a fresh grant applies only
 * after the app restarts.
 */
export async function requestInputMonitoringPermission(): Promise<boolean> {
	try {
		return await invokeWhenReady<boolean>(
			"request_input_monitoring_permission"
		);
	} catch {
		return false;
	}
}

/** Open the OS Input-Monitoring-privacy settings pane. False when unsupported. */
export async function openInputMonitoringSettings(): Promise<boolean> {
	const uri = INPUT_MONITORING_SETTINGS_URI[detectOs()];
	if (!uri) {
		return false;
	}
	try {
		await invokeWhenReady("open_privacy_settings", {
			capability: "inputMonitoring",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether this OS actually gates the automation capabilities behind a
 * user-grantable permission. Sourced from the backend so it stays honest across
 * platforms (macOS: true; Windows / Linux-X11: false; Linux-Wayland: true). When
 * false, the UI should show "no setup needed" instead of Grant buttons.
 */
export async function automationPermissionsRequired(): Promise<boolean> {
	try {
		return await invokeWhenReady<boolean>("automation_permissions_required");
	} catch {
		// Fall back to the cheap client-side guess if the command is unavailable.
		return detectOs() === "macos";
	}
}

/** Cheap synchronous guess of whether automation permissions apply (macOS). */
export function automationPermissionsApply(): boolean {
	return detectOs() === "macos";
}
