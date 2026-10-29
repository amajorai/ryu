import { localizeNativeCopy } from "@/src/lib/native-copy.ts";
import {
	invokeWhenReady,
	isTauriReady,
	listenWhenReady,
} from "@/src/lib/tauri-ready.ts";
import {
	agentNotificationImage,
	type NotificationSender,
} from "./agent-notification-image.ts";
import { readOsNotificationsChoice } from "./notification-preferences.ts";
import { notificationServiceWorker } from "./service-worker.ts";

/**
 * One entry point for OS-level notifications across every host of the shared
 * shell. Each host has its own delivery path, picked at call time:
 *
 * - `desktop`   — Tauri command `show_os_notification` (native banner/toast with
 *                 the sender's avatar image; the webview `Notification` API is
 *                 missing or inert in WKWebView and WebView2).
 * - `extension` — `chrome.notifications` (the avatar is the notification icon).
 * - `web`       — the Notifications API, falling back to the service worker
 *                 registration on mobile browsers where `new Notification()` throws.
 *
 * Nothing here prompts. Permission is asked once, from a user gesture, by the
 * onboarding step or the settings row ({@link requestOsNotificationPermission}).
 */
export type NotificationPlatform =
	| "desktop"
	| "extension"
	| "web"
	| "unsupported";

export type OsNotificationPermission =
	| "granted"
	| "default"
	| "denied"
	| "unsupported";

export interface OsNotificationInput {
	body?: string | null;
	/** Runs when the user clicks the notification (after the app is focused). */
	onClick?: () => void;
	/** The agent the notification is from; its avatar becomes the image. */
	sender?: NotificationSender | null;
	/** Replaces an earlier notification with the same tag where the OS supports it. */
	tag?: string | null;
	title: string;
}

interface ChromeNotificationsApi {
	clear: (id: string) => unknown;
	create: (
		id: string,
		options: {
			iconUrl: string;
			message: string;
			priority?: number;
			title: string;
			type: "basic";
		}
	) => unknown;
	onClicked: { addListener: (listener: (id: string) => void) => void };
}

interface ChromePermissionsApi {
	contains: (permissions: { permissions: string[] }) => Promise<boolean>;
	request: (permissions: { permissions: string[] }) => Promise<boolean>;
}

interface ChromeLike {
	notifications?: ChromeNotificationsApi;
	permissions?: ChromePermissionsApi;
	runtime?: { getURL?: (path: string) => string; id?: string };
	tabs?: {
		getCurrent: () => Promise<{ id?: number; windowId?: number } | undefined>;
		update: (id: number, props: { active: boolean }) => unknown;
	};
	windows?: { update: (id: number, props: { focused: boolean }) => unknown };
}

const EXTENSION_PERMISSION = { permissions: ["notifications"] };
const EXTENSION_ICON_PATH = "/icon/128.png";
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 2000;
const CLICK_HANDLER_LIMIT = 64;
const DESKTOP_CLICK_EVENT = "os-notification-clicked";

function extensionApi(): ChromeLike | null {
	const candidate = (globalThis as { chrome?: ChromeLike }).chrome;
	return candidate?.runtime?.id && candidate.permissions ? candidate : null;
}

/** Which delivery path this page has. */
export function getNotificationPlatform(): NotificationPlatform {
	if (isTauriReady()) {
		return "desktop";
	}
	if (extensionApi()) {
		return "extension";
	}
	if (
		typeof globalThis.Notification === "function" &&
		canShowPageNotifications()
	) {
		return "web";
	}
	return "unsupported";
}

/**
 * Phone browsers (Chrome on Android, Safari on iPhone and iPad, including Home
 * Screen web apps) only show notifications through a service worker, so a page
 * without one cannot deliver them even after permission is granted. The web
 * app registers one at startup (see `service-worker.ts`).
 */
function canShowPageNotifications(): boolean {
	const userAgent = globalThis.navigator?.userAgent ?? "";
	if (!/Android|iPhone|iPad|iPod/u.test(userAgent)) {
		return true;
	}
	return notificationServiceWorker() !== null;
}

/** Current grant for this page, without prompting. */
export async function getOsNotificationPermission(): Promise<OsNotificationPermission> {
	switch (getNotificationPlatform()) {
		case "desktop":
			// Desktop OSes gate notifications in their own settings and do not
			// tell an app it was muted; the settings link covers that case.
			return "granted";
		case "extension": {
			try {
				const granted =
					await extensionApi()?.permissions?.contains(EXTENSION_PERMISSION);
				return granted ? "granted" : "default";
			} catch {
				return "default";
			}
		}
		case "web":
			return Notification.permission;
		default:
			return "unsupported";
	}
}

/**
 * Ask for notification permission. Must run inside a user gesture (a click):
 * browsers ignore or auto-deny prompts that are not.
 */
export async function requestOsNotificationPermission(): Promise<OsNotificationPermission> {
	switch (getNotificationPlatform()) {
		case "desktop":
			return "granted";
		case "extension": {
			try {
				const granted =
					await extensionApi()?.permissions?.request(EXTENSION_PERMISSION);
				return granted ? "granted" : "denied";
			} catch {
				return "denied";
			}
		}
		case "web":
			try {
				return await Notification.requestPermission();
			} catch {
				return Notification.permission;
			}
		default:
			return "unsupported";
	}
}

/**
 * Whether notifications should be shown now. An explicit choice wins. Before
 * the user has chosen, desktop keeps its earlier always-on behaviour and the
 * browser hosts follow an existing grant, so nobody loses notifications they
 * already had and nobody is prompted mid-session.
 */
export function osNotificationsEnabled(): boolean {
	const choice = readOsNotificationsChoice();
	if (choice !== null) {
		return choice;
	}
	const platform = getNotificationPlatform();
	if (platform === "desktop") {
		return true;
	}
	return platform === "web" && Notification.permission === "granted";
}

/**
 * Look up the agent behind a notification. Loaded on demand so the stream
 * hooks that raise notifications do not pull the agent API and query cache
 * into their own module graph.
 */
export async function resolveNotificationSender(
	agentId: string | null | undefined
): Promise<NotificationSender | null> {
	if (!agentId) {
		return null;
	}
	try {
		const { findNotificationSender } = await import("./notification-sender.ts");
		return findNotificationSender(agentId);
	} catch {
		return null;
	}
}

// ── Click routing ────────────────────────────────────────────────────────────

const clickHandlers = new Map<string, () => void>();
let desktopClickListener: Promise<unknown> | null = null;
let extensionClickListener = false;
let sequence = 0;

function rememberClick(id: string, onClick: (() => void) | undefined): void {
	clickHandlers.delete(id);
	if (!onClick) {
		return;
	}
	if (clickHandlers.size >= CLICK_HANDLER_LIMIT) {
		const oldest = clickHandlers.keys().next().value;
		if (oldest !== undefined) {
			clickHandlers.delete(oldest);
		}
	}
	clickHandlers.set(id, onClick);
}

function runClick(id: string | null | undefined): void {
	if (!id) {
		return;
	}
	const handler = clickHandlers.get(id);
	clickHandlers.delete(id);
	try {
		window.focus();
		handler?.();
	} catch {
		// A stale route must not break later notifications.
	}
}

function nextId(tag: string | null | undefined): string {
	sequence += 1;
	return tag ?? `ryu-notification-${Date.now()}-${sequence}`;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

async function deliverDesktop(
	id: string,
	input: OsNotificationInput,
	image: string | null
): Promise<void> {
	desktopClickListener ??= listenWhenReady<{ tag?: string | null }>(
		DESKTOP_CLICK_EVENT,
		(event) => runClick(event.payload?.tag)
	).catch(() => {
		desktopClickListener = null;
	});
	await invokeWhenReady("show_os_notification", {
		input: {
			title: input.title,
			body: input.body ?? null,
			imagePngBase64: image ? image.slice(image.indexOf(",") + 1) : null,
			tag: id,
		},
	});
}

async function focusExtensionPage(api: ChromeLike): Promise<void> {
	const tab = await api.tabs?.getCurrent();
	if (tab?.id !== undefined) {
		await api.tabs?.update(tab.id, { active: true });
	}
	if (tab?.windowId !== undefined) {
		await api.windows?.update(tab.windowId, { focused: true });
	}
}

async function deliverExtension(
	id: string,
	input: OsNotificationInput,
	image: string | null
): Promise<void> {
	const api = extensionApi();
	const notifications = api?.notifications;
	if (!(api && notifications)) {
		// The optional permission is not granted, so the API is absent.
		return;
	}
	if (!extensionClickListener) {
		extensionClickListener = true;
		notifications.onClicked.addListener((clickedId) => {
			Promise.resolve(focusExtensionPage(api))
				.catch(() => undefined)
				.finally(() => runClick(clickedId));
			Promise.resolve(notifications.clear(clickedId)).catch(() => undefined);
		});
	}
	await notifications.create(id, {
		type: "basic",
		iconUrl:
			image ??
			api.runtime?.getURL?.(EXTENSION_ICON_PATH) ??
			EXTENSION_ICON_PATH,
		title: input.title,
		message: input.body ?? "",
		priority: 1,
	});
}

let workerClickListener = false;

function listenForWorkerClicks(): void {
	const container = globalThis.navigator?.serviceWorker;
	if (workerClickListener || !container) {
		return;
	}
	workerClickListener = true;
	container.addEventListener("message", (event: MessageEvent<unknown>) => {
		const message = event.data as { id?: unknown; type?: unknown } | null;
		if (
			message?.type === "ryu:notification-click" &&
			typeof message.id === "string"
		) {
			runClick(message.id);
		}
	});
}

async function deliverWeb(
	id: string,
	input: OsNotificationInput,
	image: string | null
): Promise<void> {
	if (Notification.permission !== "granted") {
		return;
	}
	// Only a caller's own tag goes to the browser: a tag replaces any earlier
	// notification that carries it, and clicks route through the instance.
	const options: NotificationOptions = {
		body: input.body ?? undefined,
		icon: image ?? undefined,
		tag: input.tag ?? undefined,
	};
	const worker = notificationServiceWorker();
	if (worker) {
		// Worker-shown notifications work on phones and outlive the tab; the
		// worker posts clicks back to the page that is focused.
		listenForWorkerClicks();
		await worker.showNotification(input.title, {
			...options,
			badge: "/web-app-manifest-192x192.png",
			data: { ryuNotificationId: id },
		});
		return;
	}
	const notification = new Notification(input.title, options);
	notification.onclick = () => {
		notification.close();
		runClick(id);
	};
}

/**
 * Show an OS-level notification if the user enabled them on this device.
 * Best-effort: delivery failures are swallowed so a notification can never
 * break the event stream that raised it.
 */
export async function showOsNotification(
	input: OsNotificationInput
): Promise<void> {
	if (!osNotificationsEnabled()) {
		return;
	}
	const platform = getNotificationPlatform();
	if (platform === "unsupported") {
		return;
	}
	// Native notifications bypass the DOM localizer, so known UI copy is
	// translated here; runtime text (names, messages) passes through unchanged.
	const title = localizeNativeCopy(input.title).slice(0, MAX_TITLE_CHARS);
	const body = localizeNativeCopy(input.body)?.slice(0, MAX_BODY_CHARS) ?? null;
	const id = nextId(input.tag);
	rememberClick(id, input.onClick);
	try {
		const image = input.sender
			? await agentNotificationImage(input.sender)
			: null;
		const payload = { ...input, title, body };
		if (platform === "desktop") {
			await deliverDesktop(id, payload, image);
		} else if (platform === "extension") {
			await deliverExtension(id, payload, image);
		} else {
			await deliverWeb(id, payload, image);
		}
	} catch {
		clickHandlers.delete(id);
	}
}

export function resetOsNotifyForTests(): void {
	clickHandlers.clear();
	desktopClickListener = null;
	extensionClickListener = false;
	workerClickListener = false;
	sequence = 0;
}
