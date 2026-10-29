import { APP_DOWNLOAD_GRANT, ExtensionHost } from "@ryu/app-host/ExtensionHost";
import {
	type Capability,
	capabilitiesFromGrants,
	type HostServices,
	validatePluginRoute,
} from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { Toaster, toast } from "@ryu/ui/components/sileo.tsx";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	createScopedToastHost,
	createSileoToastRenderer,
} from "../../../../packages/app-host/src/toast-host.ts";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";

const PLUGIN_ID = "@ryu/slides";
const STORAGE_NAMESPACE = "slides";
const STORAGE_KEY = "state.v1";
const MODEL_RESULT = JSON.stringify({
	slides: [
		{
			body: "Choose one signal and remove the rest.",
			headline: "Make the signal clear",
			visualPrompt: "A calm editorial desk",
		},
		{
			body: "Give each frame a single job.",
			headline: "One frame, one idea",
			visualPrompt: "Three cards in a sequence",
		},
		{
			body: "End with the action you want people to take.",
			headline: "Close with a next step",
			visualPrompt: "An open door",
		},
	],
});

interface MountOptions {
	appHtml: string;
	grants: string[];
	pluginId: string;
}
interface FixtureCall {
	args:
		| Parameters<NonNullable<HostServices["storageGet"]>>[0]
		| Parameters<NonNullable<HostServices["storageSet"]>>[0]
		| Parameters<NonNullable<HostServices["modelComplete"]>>[0]
		| Parameters<NonNullable<HostServices["generateImage"]>>[0];
	method: string;
}
interface SlidesProofApi {
	calls: () => FixtureCall[];
	connected: () => boolean;
	mount: (options: MountOptions) => void;
	persisted: () => ProofJsonValue;
	reset: () => void;
}

declare global {
	interface Window {
		__slidesProof: SlidesProofApi;
	}
}

const storage = new Map<string, string>();
const calls: FixtureCall[] = [];
let connected = false;
let root: Root | null = null;
let toastHost = createScopedToastHost({
	renderer: createSileoToastRenderer(toast),
	sourceId: PLUGIN_ID,
});

function address(namespace: string | undefined, key: string): string {
	return `${namespace ?? ""}/${key}`;
}

function services(pluginId: string): HostServices {
	return {
		listAgents: async () => [],
		registerRoute: (claim) =>
			validatePluginRoute(pluginId, claim)
				? Promise.resolve({ path: claim.path })
				: Promise.reject(
						new Error("Route is outside the companion namespace.")
					),
		storageGet: async ({ key, namespace }) => {
			calls.push({ args: { key, namespace }, method: "storage.get" });
			return storage.get(address(namespace, key)) ?? null;
		},
		storageSet: async ({ key, namespace, value }) => {
			calls.push({ args: { key, namespace, value }, method: "storage.set" });
			storage.set(address(namespace, key), value);
		},
		modelComplete: async (input) => {
			calls.push({
				args: structuredClone(input),
				method: "model.complete",
			});
			return MODEL_RESULT;
		},
		generateImage: async (input) => {
			calls.push({
				args: structuredClone(input),
				method: "media.image",
			});
			return {
				images: [
					{
						url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
					},
				],
			};
		},
	};
}

function reset(): void {
	storage.clear();
	calls.length = 0;
}

function mount(options: MountOptions): void {
	toastHost.dispose();
	toastHost = createScopedToastHost({
		renderer: createSileoToastRenderer(toast),
		sourceId: options.pluginId,
	});
	connected = false;
	const nonce = crypto.randomUUID();
	const granted: ReadonlySet<Capability> = capabilitiesFromGrants(
		options.grants
	);
	const srcdoc = htmlCompanionSrcdoc(nonce, options.appHtml, options.pluginId);
	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("Slides proof host is missing #host-root.");
	}
	root?.unmount();
	root = createRoot(container);
	root.render(
		createElement(
			"div",
			{ style: { minHeight: "100%", height: "100%" } },
			createElement(ExtensionHost, {
				srcdoc,
				nonce,
				granted,
				allowDownloads: options.grants.includes(APP_DOWNLOAD_GRANT),
				services: services(options.pluginId),
				onConnected: () => {
					connected = true;
				},
				title: "Slides behavior proof",
			}),
			createElement(Toaster, { position: "bottom-right" })
		)
	);
}

window.__slidesProof = {
	connected: () => connected,
	calls: () => structuredClone(calls),
	mount,
	reset,
	persisted: () => {
		const serialized = storage.get(address(STORAGE_NAMESPACE, STORAGE_KEY));
		return serialized ? parseProofJson(serialized) : null;
	},
};
document.body.setAttribute("data-harness-ready", "1");
