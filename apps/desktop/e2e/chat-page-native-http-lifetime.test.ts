import { expect, test } from "bun:test";
import {
	EXPECTED_NATIVE_WINDOW_LIFETIME,
	nativeWindowLifetimeProjection,
} from "./chat-page-native-http-lifetime.ts";

const valid = {
	snapshot: { callbacks: 2, listeners: 2, unexpected: [] as string[] },
	details: {
		listeners: [
			{ id: 3, event: "desktop-secret-changed", handler: 4 },
			{ id: 14, event: "tauri://resize", handler: 21 },
		],
		callbackIds: [4, 21],
		unexpected: [] as unknown[],
		heldClipsListenerIds: [] as number[],
	},
};
test("the native cleanup oracle accepts exactly the fullscreen handler and the sealed-vault subscription and rejects leaked scopes, callback IDs, unknown contracts or pending subscriptions", () => {
	expect(nativeWindowLifetimeProjection(valid)).toEqual(
		EXPECTED_NATIVE_WINDOW_LIFETIME
	);
	const failures: Array<(state: typeof valid) => void> = [
		(state) => {
			state.details.listeners.push({
				id: 25,
				event: "clips:quick-attach",
				handler: 30,
			});
		},
		(state) => {
			state.details.listeners.push({
				id: 25,
				event: "tauri://resize",
				handler: 30,
			});
		},
		(state) => {
			state.details.listeners[1]!.event = "tray-open-palette";
		},
		(state) => {
			state.details.listeners.shift();
		},
		(state) => {
			state.details.callbackIds = [4, 30];
		},
		(state) => {
			state.details.callbackIds.push(30);
		},
		(state) => {
			state.details.callbackIds = [];
		},
		(state) => {
			state.details.listeners = [];
		},
		(state) => {
			state.snapshot.callbacks = 1;
		},
		(state) => {
			state.snapshot.listeners = 3;
		},
		(state) => {
			state.snapshot.unexpected.push("plugin:store|foreign");
		},
		(state) => {
			state.details.unexpected.push({
				command: "plugin:store|load",
				args: { path: "foreign.bin" },
				error: "refused",
			});
		},
		(state) => {
			state.details.heldClipsListenerIds.push(25);
		},
	];
	for (const mutate of failures) {
		const state = structuredClone(valid);
		mutate(state);
		expect(nativeWindowLifetimeProjection(state)).not.toEqual(
			EXPECTED_NATIVE_WINDOW_LIFETIME
		);
	}
});
