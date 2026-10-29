import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import { capabilitiesFromGrants, type HostServices } from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
	ModelCall,
	SitesCall,
	SitesProofApi,
} from "./sites-companion-proof.types.ts";

const pluginId = "@ryu/sites";
const approvedGrants = [
	"app:http",
	"hook:side-model",
	"hook:run-agent",
	"spaces:docs",
	"identity:read",
	"security:check",
];

interface Failure {
	message: string;
	method: string;
	path: string;
}

declare global {
	interface Window {
		__sitesProof: SitesProofApi;
	}
}

const calls: SitesCall[] = [];
const modelCalls: ModelCall[] = [];
const failures: Failure[] = [];
const externalUrls: string[] = [];
const granted = capabilitiesFromGrants(approvedGrants);
let root: Root | null = null;
let connected = false;
let modelError: string | null = null;
let modelResponse =
	'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture site</title></head><body><h1>Generated Sites preview</h1></body></html>';

function services(): HostServices {
	return {
		listAgents: async () => [],
		registerRoute: async (claim) => ({ path: claim.path }),
		appRequest: async ({ body, method, path }) => {
			const requestMethod = method ?? "GET";
			const call: SitesCall = {
				...(body === undefined ? undefined : { body: structuredClone(body) }),
				method: requestMethod,
				path,
				status: 0,
			};
			calls.push(call);
			const failureIndex = failures.findIndex(
				(failure) => failure.method === requestMethod && failure.path === path
			);
			if (failureIndex >= 0) {
				const [failure] = failures.splice(failureIndex, 1);
				call.status = 503;
				call.result = { error: { message: failure?.message } };
				throw new Error(failure?.message ?? "Sites service unavailable.");
			}
			const response = await fetch(`/__proof/sites${path}`, {
				method: requestMethod,
				headers:
					body === undefined
						? undefined
						: { "content-type": "application/json" },
				...(body === undefined ? undefined : { body: JSON.stringify(body) }),
			});
			const result = await response.json().catch(() => null);
			call.status = response.status;
			call.result = structuredClone(result);
			if (!response.ok) {
				const message =
					isNativeObjectLike(result) && isNativeText(result.error?.message)
						? result.error.message
						: "The local Sites sidecar rejected the request.";
				throw new Error(message);
			}
			return appResponseValueSchema.parse(result);
		},
		modelComplete: async ({ prompt, system }) => {
			modelCalls.push({
				prompt,
				...(system === undefined ? undefined : { system }),
			});
			if (modelError) {
				const message = modelError;
				modelError = null;
				throw new Error(message);
			}
			return modelResponse;
		},
		openExternal: async ({ href }) => {
			externalUrls.push(href);
		},
	};
}

function mount(input: { appHtml: string }): void {
	if (!input.appHtml) {
		throw new Error("Sites proof requires the compiled single-file Companion.");
	}
	calls.length = 0;
	modelCalls.length = 0;
	externalUrls.length = 0;
	modelError = null;
	connected = false;
	const nonce = crypto.randomUUID();
	const srcdoc = htmlCompanionSrcdoc(nonce, input.appHtml, pluginId);
	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("Sites proof is missing #host-root.");
	}
	root?.unmount();
	root = createRoot(container);
	root.render(
		createElement(ExtensionHost, {
			granted,
			nonce,
			onConnected: () => {
				connected = true;
			},
			services: services(),
			srcdoc,
			title: "Sites proof",
		})
	);
}

window.__sitesProof = {
	calls: () => structuredClone(calls),
	clearCalls: () => {
		calls.length = 0;
	},
	connected: () => connected,
	failNext: (method, path, message) => {
		failures.push({ method, path, message });
	},
	failNextModel: (message) => {
		modelError = message;
	},
	modelCalls: () => structuredClone(modelCalls),
	mount,
	openedExternal: () => [...externalUrls],
	setModelResponse: (response) => {
		modelResponse = response;
	},
};

document.body.dataset.harnessReady = "1";
