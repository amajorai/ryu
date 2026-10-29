import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import {
	type Capability,
	capabilitiesFromGrants,
	type HostServices,
	validatePluginRoute,
} from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { Toaster, toast } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	createScopedToastHost,
	createSileoToastRenderer,
} from "../../../../packages/app-host/src/toast-host.ts";

const PLUGIN_ID = "@ryu/social";
const GRANTS = [
	"core:list_agents",
	"hook:side-model",
	"social:crud",
	"ui:toast",
];
const MODEL_REPLY = "Thanks for sharing this — I will follow up shortly.";

type SocialRequestCall = Parameters<
	NonNullable<HostServices["socialRequest"]>
>[0];

interface ModelCall {
	model?: string;
	prompt: string;
	provider?: string;
	system?: string;
}

interface ExternalLinkCall {
	href: string;
}

interface SocialInboxProofApi {
	calls: () => SocialRequestCall[];
	connected: () => boolean;
	externalLinkCalls: () => ExternalLinkCall[];
	modelCalls: () => ModelCall[];
	mount: (appHtml: string) => void;
}

declare global {
	interface Window {
		__socialInboxProof: SocialInboxProofApi;
	}
}

const calls: SocialRequestCall[] = [];
const externalLinkCalls: ExternalLinkCall[] = [];
const modelCalls: ModelCall[] = [];
let connected = false;
let root: Root | null = null;
let toastHost = createScopedToastHost({
	renderer: createSileoToastRenderer(toast),
	sourceId: PLUGIN_ID,
});

function services(): HostServices {
	return {
		catalogModels: async ({ providerId }) => ({
			models: [{ id: "fixture-model", name: "Local fixture model" }],
			providerId,
			source: "local inbox proof",
		}),
		catalogSnapshot: async () => ({
			agents: [],
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
		}),
		openExternal: async (input) => {
			externalLinkCalls.push(structuredClone(input));
		},
		listAgents: async () => [],
		modelComplete: async (input) => {
			modelCalls.push(structuredClone(input));
			return MODEL_REPLY;
		},
		registerRoute: (claim) =>
			validatePluginRoute(PLUGIN_ID, claim)
				? Promise.resolve({ path: claim.path })
				: Promise.reject(new Error("Route is outside the Social app.")),
		socialOpen: () => undefined,
		socialOpenList: () => undefined,
		socialRequest: async (input) => {
			calls.push(structuredClone(input));
			const response = await fetch(`/__social${input.path}`, {
				method: input.method,
				headers: { "content-type": "application/json" },
				...(input.body === undefined
					? undefined
					: { body: JSON.stringify(input.body) }),
			});
			const body = await response.json().catch(() => ({}));
			if (!response.ok) {
				const message = isNativeText(body.error)
					? body.error
					: isNativeText(body.message)
						? body.message
						: "The local Social fixture rejected the request.";
				throw new Error(message);
			}
			return appResponseValueSchema.parse(body);
		},
		uiToastDismiss: (input) => toastHost.dismiss(input),
		uiToastShow: (input) => toastHost.show(input),
		uiToastUpdate: (input) => toastHost.update(input),
	};
}

function mount(appHtml: string): void {
	if (!isNativeText(appHtml) || appHtml.length === 0) {
		throw new Error("The production Social HTML bundle was not provided.");
	}
	toastHost.dispose();
	toastHost = createScopedToastHost({
		renderer: createSileoToastRenderer(toast),
		sourceId: PLUGIN_ID,
	});
	calls.length = 0;
	externalLinkCalls.length = 0;
	modelCalls.length = 0;
	connected = false;
	const nonce = crypto.randomUUID();
	const granted: ReadonlySet<Capability> = capabilitiesFromGrants(GRANTS);
	const srcdoc = htmlCompanionSrcdoc(nonce, appHtml, PLUGIN_ID, {
		section: "inbox",
		workspaceId: "ws-inbox-proof",
	});
	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("Social Inbox proof host is missing #host-root.");
	}
	root?.unmount();
	root = createRoot(container);
	root.render(
		createElement(
			"div",
			{ style: { width: "100%", height: "100%" } },
			createElement(ExtensionHost, {
				granted,
				nonce,
				onConnected: () => {
					connected = true;
				},
				services: services(),
				srcdoc,
				title: "Social Inbox proof",
			}),
			createElement(Toaster, { position: "bottom-right" })
		)
	);
}

window.__socialInboxProof = {
	calls: () => structuredClone(calls),
	connected: () => connected,
	externalLinkCalls: () => structuredClone(externalLinkCalls),
	modelCalls: () => structuredClone(modelCalls),
	mount,
};
document.body.setAttribute("data-harness-ready", "1");
