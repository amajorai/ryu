import type { InvokeArgs } from "@tauri-apps/api/core";
import { z } from "zod";
import {
	pluginDocumentSchema,
	pluginValueSchema,
} from "../src/lib/api/plugin-wire-values.ts";
import { answerDesktopSecretSlot } from "./harness/desktop-secret-slots.ts";

const nativeCallSchema = z.object({
	command: z.string(),
	args: pluginValueSchema.optional(),
});
const nativeCallHistorySchema = z.array(nativeCallSchema);
const nativeCommandArgumentsSchema = pluginDocumentSchema;
const listenArgumentsSchema = z.object({
	event: z.string(),
	handler: z.number(),
});
const unlistenArgumentsSchema = z.object({
	event: z.string(),
	eventId: z.number(),
});

export function installConsoleNativeFixture() {
	if (location.protocol === "about:") {
		return;
	}
	if (!sessionStorage.getItem("console-access-seeded")) {
		sessionStorage.setItem("console-access-seeded", "true");
		localStorage.setItem(
			"ryu_accounts",
			JSON.stringify([
				{
					userId: "owner-one",
					name: "Owner One",
					email: "owner@example.test",
					image: null,
					token: "console-owner-token",
				},
				{
					userId: "member-two",
					name: "Member Two",
					email: "member@example.test",
					image: null,
					token: "console-member-token",
				},
			])
		);
		localStorage.setItem("ryu_active_user_id", "owner-one");
		localStorage.setItem("ryu_session_token", "console-owner-token");
		localStorage.setItem("ryu_startup_selection_mode", "never");
		localStorage.setItem("ryu:product-mode", "console");
		localStorage.setItem("ryu:startup-realm", "last-used");
		localStorage.setItem("ryu_desktop_onboarding_complete", "true");
		for (const name of ["a", "b"]) {
			localStorage.setItem(
				`ryu_node_setup_complete:http://managed-${name}.example.test`,
				"true"
			);
		}
	}
	let nextCallbackId = 1;
	let nextEventId = 1;
	const eventListeners = new Map<number, string>();
	// Installed @tauri-apps/api/event.js removes its JS registration before
	// invoking plugin:event|unlisten. Model that native boundary on unmount.
	Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
		configurable: true,
		value: {
			unregisterListener: (event: string, eventId: number) => {
				if (eventListeners.get(eventId) === event) {
					eventListeners.delete(eventId);
				}
			},
		},
	});
	Object.defineProperty(window, "__TAURI_INTERNALS__", {
		configurable: true,
		value: {
			metadata: {
				currentWindow: { label: "main" },
				currentWebview: { label: "main" },
			},
			transformCallback: () => nextCallbackId++,
			unregisterCallback: () => undefined,
			invoke: async (command: string, args?: InvokeArgs) => {
				const calls = nativeCallHistorySchema.parse(
					JSON.parse(sessionStorage.getItem("console-native-calls") ?? "[]")
				);
				const call = nativeCallSchema.parse(
					JSON.parse(JSON.stringify({ command, args }))
				);
				calls.push(call);
				const parsedArguments = nativeCommandArgumentsSchema.safeParse(
					call.args
				);
				const argumentsRecord = parsedArguments.success
					? parsedArguments.data
					: {};
				sessionStorage.setItem("console-native-calls", JSON.stringify(calls));
				if (command.startsWith("desktop_secret_")) {
					// The sealed `auth-vault` / `license-key` slots, kept in this tab's
					// sessionStorage so they survive the reloads an account switch and
					// sign-out trigger. The plaintext vault seeded above migrates in on
					// first load and is purged from localStorage, as on an upgrade.
					return answerDesktopSecretSlot(
						sessionStorage,
						command,
						argumentsRecord
					).value;
				}
				if (command === "list_nodes") {
					return {
						default:
							localStorage.getItem("console-default-node") ?? "Managed A",
						nodes: [
							{ name: "local", url: "http://127.0.0.1:5497", token: null },
							{
								name: "Managed A",
								url: "http://managed-a.example.test",
								token: "node-a-token",
							},
							{
								name: "Managed B",
								url: "http://managed-b.example.test",
								token: "node-b-token",
							},
						],
					};
				}
				if (command === "set_default_node") {
					localStorage.setItem(
						"console-default-node",
						String(argumentsRecord.name)
					);
					return;
				}
				if (command === "plugin:store|load") {
					return 1;
				}
				if (
					command === "plugin:event|listen" &&
					listenArgumentsSchema.safeParse(argumentsRecord).success
				) {
					const eventId = nextEventId++;
					eventListeners.set(
						eventId,
						listenArgumentsSchema.parse(argumentsRecord).event
					);
					return eventId;
				}
				if (
					command === "plugin:event|unlisten" &&
					unlistenArgumentsSchema.safeParse(argumentsRecord).success
				) {
					eventListeners.delete(
						unlistenArgumentsSchema.parse(argumentsRecord).eventId
					);
					return;
				}
				if (command === "plugin:store|get") {
					return [null, false];
				}
				if (command === "get_ryu_status") {
					return "running";
				}
				return null;
			},
		},
	});
}

installConsoleNativeFixture();
