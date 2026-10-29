import { useSyncExternalStore } from "react";
import {
	getNotificationPlatform,
	type NotificationPlatform,
} from "./os-notify.ts";
import { onNotificationServiceWorkerReady } from "./service-worker.ts";

/**
 * The notification delivery path for this page, re-read when the web app's
 * service worker becomes active (phone browsers only gain notifications then).
 */
export function useNotificationPlatform(): NotificationPlatform {
	return useSyncExternalStore(
		onNotificationServiceWorkerReady,
		getNotificationPlatform,
		() => "unsupported"
	);
}
