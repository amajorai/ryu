import {
	ExtensionHost,
	shouldEnableCompanionFormEvents,
} from "@ryu/app-host/ExtensionHost";
import {
	capabilitiesFromGrants,
	validatePluginRoute,
	type HostServices,
} from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
	RecordApp,
	RecordCall,
	RecordCompanionApi,
} from "./record-companion-regression.types.ts";

let root: Root | null = null;
let connected = false;
let holdNext = false;
let release: ((accept: boolean) => void) | null = null;
const calls: RecordCall[] = [];
const storeKey = (app: RecordApp) => `record-companion-regression:${app}`;
function validate(
	app: RecordApp,
	input: { namespace?: string; key: string }
): void {
	const key = app === "drawesome" ? "sketch.v1" : "state.v1";
	if (input.namespace !== app || input.key !== key) {
		throw new Error("Unexpected Companion storage authority.");
	}
}
const api: RecordCompanionApi = {
	mount({ app, appHtml, reset = false }) {
		if (release) {
			throw new Error(
				"Finish the held storage write before switching Companions."
			);
		}
		root?.unmount();
		if (reset) {
			localStorage.removeItem(storeKey(app));
		}
		calls.length = 0;
		connected = false;
		holdNext = false;
		const services: HostServices = {
			listAgents: async () => [],
			registerRoute: async (claim) => {
				if (!validatePluginRoute(`@ryu/${app}`, claim)) {
					throw new Error("Unexpected Companion route authority.");
				}
				return { path: claim.path };
			},
			storageGet: async (input) => {
				validate(app, input);
				if (Object.keys(input).sort().join(",") !== "key,namespace") {
					throw new Error("Unexpected storage read shape.");
				}
				calls.push({
					method: "storage.get",
					input: structuredClone(input),
					status: "accepted",
				});
				return localStorage.getItem(storeKey(app));
			},
			storageSet: async (input) => {
				validate(app, input);
				if (Object.keys(input).sort().join(",") !== "key,namespace,value") {
					throw new Error("Unexpected storage write shape.");
				}
				JSON.parse(input.value);
				const call: RecordCall = {
					method: "storage.set",
					input: structuredClone(input),
					status: "pending",
				};
				calls.push(call);
				if (holdNext) {
					holdNext = false;
					const accepted = await new Promise<boolean>((resolve) => {
						release = resolve;
					});
					release = null;
					if (!accepted) {
						call.status = "refused";
						throw new Error(
							"The selected Companion storage write was refused."
						);
					}
				}
				localStorage.setItem(storeKey(app), input.value);
				call.status = "accepted";
			},
			uiToastShow: async () => "record-proof-toast",
		};
		const container = document.getElementById("host-root");
		if (!container) {
			throw new Error("Missing Companion regression host.");
		}
		const nonce = crypto.randomUUID();
		root = createRoot(container);
		root.render(
			createElement(ExtensionHost, {
				// Match PluginHostPanel for these trusted, compiled first-party HTML bundles.
				// ExtensionHost still requires connect-src/form-action none before granting forms.
				allowForms: shouldEnableCompanionFormEvents(true, true),
				granted: capabilitiesFromGrants(["storage:kv", "ui:toast"]),
				nonce,
				onConnected: () => {
					connected = true;
				},
				services,
				srcdoc: htmlCompanionSrcdoc(nonce, appHtml, `@ryu/${app}`),
				title: "Record Companion regression",
			})
		);
	},
	calls: () => structuredClone(calls),
	connected: () => connected,
	stored: (app) => localStorage.getItem(storeKey(app)),
	holdNextWrite: () => {
		if (holdNext || release) {
			throw new Error("A held write is already queued.");
		}
		holdNext = true;
	},
	releaseWrite: (accept) => {
		if (!release) {
			throw new Error("No pending storage write to release.");
		}
		release(accept);
	},
};
Reflect.set(window, "__recordCompanion", api);
document.body.dataset.harnessReady = "1";
