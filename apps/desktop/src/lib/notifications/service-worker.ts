/**
 * The web app's notification service worker (`apps/webapp/public/
 * ryu-notifications-sw.js`). Phone browsers only show notifications through a
 * service worker, so the web host registers it at startup; the desktop app and
 * the extension never do, because they have their own delivery paths.
 */

const READY_TIMEOUT_MS = 4000;

let activeRegistration: ServiceWorkerRegistration | null = null;
const readyListeners = new Set<() => void>();

/** The registration that shows notifications, once its worker is active. */
export function notificationServiceWorker(): ServiceWorkerRegistration | null {
	return activeRegistration?.active ? activeRegistration : null;
}

/** Re-render subscribers when the worker becomes active (platform may change). */
export function onNotificationServiceWorkerReady(
	listener: () => void
): () => void {
	readyListeners.add(listener);
	return () => {
		readyListeners.delete(listener);
	};
}

/**
 * Register the notification worker. Best-effort: a browser without service
 * workers, a private window, or an insecure origin simply keeps the page-level
 * Notifications API.
 */
export async function registerNotificationServiceWorker(
	scriptUrl: string
): Promise<void> {
	const container = globalThis.navigator?.serviceWorker;
	if (!container) {
		return;
	}
	try {
		await container.register(scriptUrl, { scope: "/" });
		const registration = await Promise.race([
			container.ready,
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), READY_TIMEOUT_MS)
			),
		]);
		if (!registration) {
			return;
		}
		activeRegistration = registration;
		for (const listener of readyListeners) {
			listener();
		}
	} catch {
		// Registration is refused on insecure origins and in some private modes.
	}
}

export function resetNotificationServiceWorkerForTests(
	registration: ServiceWorkerRegistration | null = null
): void {
	activeRegistration = registration;
	readyListeners.clear();
}
