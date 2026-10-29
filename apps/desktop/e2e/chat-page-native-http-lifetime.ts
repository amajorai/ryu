import { writeFile } from "node:fs/promises";
import { expect, type Page, type TestInfo } from "@playwright/test";

interface NativeLifetime {
	details: {
		listeners: Array<{ id: number; event: string; handler: number }>;
		callbackIds: number[];
		unexpected: unknown[];
		heldClipsListenerIds: number[];
	};
	snapshot: { callbacks: number; listeners: number; unexpected: string[] };
}
// Retain every event/unknown record. Only the app-lifetime watchers may remain
// after the actual React root has unmounted: the documented fullscreen window
// watcher and the auth client's module-level subscription to its sealed
// `auth-vault` slot (`desktop-secret-changed`), which is not React-scoped.
export function nativeWindowLifetimeProjection(state: NativeLifetime) {
	const listeners = state.details.listeners;
	const callbackIds = state.details.callbackIds;
	const handlers = listeners.map((listener) => listener.handler);
	return {
		snapshot: state.snapshot,
		eventNames: listeners.map((listener) => listener.event).sort(),
		callbackIdsMatchAppWatchers:
			listeners.length === callbackIds.length &&
			listeners.every(
				(listener) =>
					Number.isSafeInteger(listener.id) &&
					Number.isSafeInteger(listener.handler)
			) &&
			new Set(handlers).size === handlers.length &&
			callbackIds.every((id) => handlers.includes(id)),
		unexpectedDetails: state.details.unexpected,
		heldClipsListenerIds: state.details.heldClipsListenerIds,
	};
}
export const EXPECTED_NATIVE_WINDOW_LIFETIME = {
	snapshot: { callbacks: 2, listeners: 2, unexpected: [] },
	eventNames: ["desktop-secret-changed", "tauri://resize"],
	callbackIdsMatchAppWatchers: true,
	unexpectedDetails: [],
	heldClipsListenerIds: [],
};
export async function assertNativeWindowLifetime(page: Page) {
	await expect
		.poll(async () => {
			const state = await page.evaluate(() => {
				const fixture = Reflect.get(window, "__chatPageNativeFixture");
				return {
					snapshot: fixture.nativeSnapshot(),
					details: fixture.nativeDiagnostics(),
				};
			});
			return nativeWindowLifetimeProjection(state);
		})
		.toEqual(EXPECTED_NATIVE_WINDOW_LIFETIME);
}
export async function persistNativeLifetimeDiagnostics(
	testInfo: TestInfo,
	details: unknown
) {
	const path = testInfo.outputPath("native-event-lifetime-and-contracts.json");
	await writeFile(path, `${JSON.stringify(details, null, 2)}\n`, "utf8");
	await testInfo.attach("native-event-lifetime-and-contracts", {
		path,
		contentType: "application/json",
	});
}
