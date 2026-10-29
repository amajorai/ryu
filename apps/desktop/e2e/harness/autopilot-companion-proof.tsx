import type { RyuCatalogSnapshot } from "@ryu/app-host/app-bridge";
import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import { capabilitiesFromGrants, type HostServices } from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { Toaster, toast } from "@ryu/ui/components/sileo.tsx";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	createScopedToastHost,
	createSileoToastRenderer,
} from "../../../../packages/app-host/src/toast-host.ts";
import type {
	AutopilotProofApi,
	AutopilotProofCall,
} from "./autopilot-companion-proof.types.ts";

const PLUGIN_ID = "@ryu/autopilot";
const GRANTS = ["core:list_agents", "hook:run-agent", "storage:kv", "ui:toast"];
const STORAGE_NAMESPACE = "autopilot";
const STORAGE_KEY = "state.v1";
const STORAGE_PREFIX = "ryu-autopilot-proof:";

const catalog: RyuCatalogSnapshot = {
	agents: [
		{
			enabled: true,
			id: "agent-research",
			installed: true,
			name: "Research Agent",
		},
		{
			enabled: true,
			id: "agent-writer",
			installed: true,
			name: "Writer Agent",
		},
		{
			enabled: false,
			id: "agent-disabled",
			installed: true,
			name: "Disabled Agent",
		},
		{
			enabled: true,
			id: "agent-not-installed",
			installed: false,
			name: "Uninstalled Agent",
		},
	],
	apiTypes: [],
	current: {
		provider: "fixture-local",
		providerRouting: {},
		routing: "auto",
	},
	hookEvents: [],
	hooks: [],
	plugins: [],
	providers: [
		{
			api: "fixture",
			authKind: "none",
			configured: true,
			id: "fixture-local",
			label: "Local fixture",
			supportsDiscovery: true,
		},
	],
	thinkingLevels: [],
	version: 1,
};

declare global {
	interface Window {
		__autopilotProof: AutopilotProofApi;
	}
}

const calls: AutopilotProofCall[] = [];
let connected = false;
let failAgentMessage: string | null = null;
let failStorageMessage: string | null = null;
let agentReply =
	"One-job hypothesis: validate a narrow workflow before expanding the product.";
let root: Root | null = null;
const toastHost = createScopedToastHost({
	renderer: createSileoToastRenderer(toast),
	sourceId: PLUGIN_ID,
});

function storageAddress(namespace: string | undefined, key: string): string {
	return `${STORAGE_PREFIX}${namespace ?? ""}:${key}`;
}

function services(): HostServices {
	return {
		catalogSnapshot: async () => {
			calls.push({
				method: "catalog.snapshot",
				result: structuredClone(catalog),
			});
			return structuredClone(catalog);
		},
		listAgents: async () =>
			catalog.agents.map(({ id, name }) => ({ id, name })),
		runAgent: async (input) => {
			calls.push({ method: "agent.run", args: structuredClone(input) });
			if (failAgentMessage) {
				const message = failAgentMessage;
				failAgentMessage = null;
				throw new Error(message);
			}
			return agentReply;
		},
		storageGet: async ({ key, namespace }) => {
			const value = localStorage.getItem(storageAddress(namespace, key));
			calls.push({
				args: { key, namespace },
				method: "storage.get",
				result: value,
			});
			return value;
		},
		storageSet: async ({ key, namespace, value }) => {
			calls.push({ args: { key, namespace, value }, method: "storage.set" });
			if (failStorageMessage) {
				const message = failStorageMessage;
				failStorageMessage = null;
				throw new Error(message);
			}
			localStorage.setItem(storageAddress(namespace, key), value);
		},
		uiToastDismiss: (input) => toastHost.dismiss(input),
		uiToastShow: (input) => toastHost.show(input),
		uiToastUpdate: (input) => toastHost.update(input),
	};
}

function mount(input: { appHtml: string; section?: string }): void {
	if (!input.appHtml) {
		throw new Error(
			"Autopilot proof requires the compiled single-file Companion."
		);
	}
	connected = false;
	const nonce = crypto.randomUUID();
	const context = input.section ? { section: input.section } : undefined;
	const srcdoc = htmlCompanionSrcdoc(nonce, input.appHtml, PLUGIN_ID, context);
	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("Autopilot proof is missing #host-root.");
	}
	root?.unmount();
	root = createRoot(container);
	root.render(
		createElement(
			"div",
			{ style: { width: "100%", height: "100%" } },
			createElement(ExtensionHost, {
				granted: capabilitiesFromGrants(GRANTS),
				nonce,
				onConnected: () => {
					connected = true;
				},
				services: services(),
				srcdoc,
				title: "Autopilot proof",
			}),
			createElement(Toaster, { position: "bottom-right" })
		)
	);
}

window.__autopilotProof = {
	calls: () => structuredClone(calls),
	clearCalls: () => {
		calls.length = 0;
	},
	connected: () => connected,
	failNextAgent: (message) => {
		failAgentMessage = message;
	},
	failNextStorageSet: (message) => {
		failStorageMessage = message;
	},
	mount,
	reset: () => {
		localStorage.removeItem(storageAddress(STORAGE_NAMESPACE, STORAGE_KEY));
		calls.length = 0;
		connected = false;
		failAgentMessage = null;
		failStorageMessage = null;
		agentReply =
			"One-job hypothesis: validate a narrow workflow before expanding the product.";
	},
	setAgentReply: (reply) => {
		agentReply = reply;
	},
	storedState: () =>
		localStorage.getItem(storageAddress(STORAGE_NAMESPACE, STORAGE_KEY)),
};

document.body.dataset.harnessReady = "1";
