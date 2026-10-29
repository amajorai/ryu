import type {
	RyuCatalogModels,
	RyuCatalogSnapshot,
} from "@ryu/app-host/app-bridge";
import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import {
	type Capability,
	CapabilityError,
	capabilitiesFromGrants,
	type HostServices,
} from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseProofJson } from "../fixture-json.ts";

const PLUGIN_ID = "@ryu/checks";
const GRANTS = [
	"app:http",
	"core:list_agents",
	"hook:side-model",
	"hook:run-agent",
];

interface ChecksRequestCall {
	body?: unknown;
	method: string;
	orgId: string;
	path: string;
	result?: unknown;
	status: number;
	tenantUserId: string;
}

interface HostCall {
	input: unknown;
	method:
		| "agent.run"
		| "catalog.models"
		| "catalog.snapshot"
		| "model.complete"
		| "ui.openExternal";
}

interface FailureInjection {
	message: string;
	method: string;
	path: string;
	status: number;
}

interface MountInput {
	appHtml: string;
	orgId: string;
	screen: string;
	tenantUserId: string;
}

interface ChecksProofApi {
	calls: () => ChecksRequestCall[];
	clearCalls: () => void;
	connected: () => boolean;
	failNext: (failure: FailureInjection) => void;
	failNextAgent: () => void;
	failNextDiscovery: () => void;
	failNextModel: () => void;
	hostCalls: () => HostCall[];
	mount: (input: MountInput) => void;
}

declare global {
	interface Window {
		__checksProof: ChecksProofApi;
	}
}

const calls: ChecksRequestCall[] = [];
const hostCalls: HostCall[] = [];
const failures: FailureInjection[] = [];
let failAgent = false;
let failDiscovery = false;
let failModel = false;
let connected = false;
let root: Root | null = null;

const catalogSnapshot: RyuCatalogSnapshot = {
	agents: [
		{
			description: "Local deterministic proof agent",
			enabled: true,
			engine: "fixture",
			id: "checks-fixture-agent",
			installed: true,
			model: "checks-fixture-model",
			name: "Checks Fixture Agent",
			recommended: true,
			title: "Checks Fixture Agent",
		},
	],
	apiTypes: ["openai-compatible"],
	current: {
		model: "checks-fixture-model",
		provider: "checks-fixture-provider",
		providerRouting: {},
		routing: "direct",
		thinkingLevel: "balanced",
	},
	hookEvents: [],
	hooks: [],
	plugins: [],
	providers: [
		{
			active: true,
			api: "openai-compatible",
			authKind: "none",
			configured: true,
			id: "checks-fixture-provider",
			label: "Checks Local Fixture",
			managed: true,
			suggestedModels: [],
			supportsDiscovery: true,
		},
	],
	thinkingLevels: ["balanced", "deep"],
	version: 1,
};

function services(input: MountInput): HostServices {
	return {
		registerRoute: () => {
			throw new CapabilityError("ui.registerRoute is not available");
		},
		openExternal: async ({ href }) => {
			hostCalls.push({ input: { href }, method: "ui.openExternal" });
		},
		appRequest: async ({ body, method, path }) => {
			const requestMethod = method ?? "GET";
			const call: ChecksRequestCall = {
				...(body === undefined
					? undefined
					: { body: parseProofJson(JSON.stringify(body)) }),
				method: requestMethod,
				orgId: input.orgId,
				path,
				status: 0,
				tenantUserId: input.tenantUserId,
			};
			calls.push(call);
			const failureIndex = failures.findIndex(
				(failure) => failure.method === requestMethod && failure.path === path
			);
			if (failureIndex !== -1) {
				const [failure] = failures.splice(failureIndex, 1);
				call.status = failure.status;
				throw new Error(failure.message);
			}

			const response = await fetch(`/__proof/checks${path}`, {
				method: requestMethod,
				headers: {
					...(body === undefined
						? undefined
						: { "content-type": "application/json" }),
					"x-ryu-caller-user-id": input.tenantUserId,
					"x-ryu-caller-org-id": input.orgId,
				},
				...(body === undefined ? undefined : { body: JSON.stringify(body) }),
			});
			const result = await response.json().catch(() => null);
			call.status = response.status;
			call.result = structuredClone(result);
			if (!response.ok) {
				const error = isNativeObjectLike(result) ? result.error : undefined;
				throw new Error(
					isNativeText(error?.message)
						? error.message
						: "The local Checks sidecar rejected the request."
				);
			}
			return appResponseValueSchema.parse(result);
		},
		listAgents: async () => {
			hostCalls.push({ input: {}, method: "catalog.snapshot" });
			return catalogSnapshot.agents.map(({ id, name }) => ({ id, name }));
		},
		catalogSnapshot: async () => {
			hostCalls.push({ input: {}, method: "catalog.snapshot" });
			return structuredClone(catalogSnapshot);
		},
		catalogModels: async ({ providerId }) => {
			hostCalls.push({ input: { providerId }, method: "catalog.models" });
			if (failDiscovery) {
				failDiscovery = false;
				throw new Error(
					"Fixture catalog discovery is temporarily unavailable."
				);
			}
			return {
				models: [{ id: "checks-fixture-model", name: "Checks Fixture Model" }],
				providerId,
				source: "deterministic local fixture",
			} satisfies RyuCatalogModels;
		},
		modelComplete: async (input) => {
			hostCalls.push({
				input: structuredClone(input),
				method: "model.complete",
			});
			if (failModel) {
				failModel = false;
				throw new Error("Fixture model service is temporarily unavailable.");
			}
			return JSON.stringify({
				cases: [
					"Returning user signs in and reaches dashboard",
					"Search returns a matching product",
					"Checkout recovers after a billing error",
				],
			});
		},
		runAgent: async (input) => {
			hostCalls.push({ input: structuredClone(input), method: "agent.run" });
			if (failAgent) {
				failAgent = false;
				throw new Error("Fixture agent runtime is temporarily unavailable.");
			}
			return JSON.stringify({
				artifacts: [
					{
						available: false,
						kind: "browser",
						label: "Browser screenshot",
					},
				],
				evidenceLevel: "agent-transcript",
				verdict: "unverified",
			});
		},
	};
}

function mount(input: MountInput): void {
	if (!(input.appHtml && input.tenantUserId)) {
		throw new Error(
			"Checks proof requires its built app and local tenant fixture."
		);
	}
	calls.length = 0;
	hostCalls.length = 0;
	connected = false;
	const nonce = crypto.randomUUID();
	const granted: ReadonlySet<Capability> = capabilitiesFromGrants(GRANTS);
	const srcdoc = htmlCompanionSrcdoc(nonce, input.appHtml, PLUGIN_ID, {
		screen: input.screen,
	});
	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("Checks proof is missing #host-root.");
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
			services: services(input),
			srcdoc,
			title: "Checks proof",
		})
	);
}

window.__checksProof = {
	calls: () => structuredClone(calls),
	clearCalls: () => {
		calls.length = 0;
	},
	connected: () => connected,
	failNext: (failure) => failures.push(failure),
	failNextAgent: () => {
		failAgent = true;
	},
	failNextDiscovery: () => {
		failDiscovery = true;
	},
	failNextModel: () => {
		failModel = true;
	},
	hostCalls: () => structuredClone(hostCalls),
	mount,
};
document.body.setAttribute("data-harness-ready", "1");
