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

const PLUGIN_ID = "@ryu/security";
const GRANTS = ["app:http"];

interface SecurityRequestCall {
	body?: unknown;
	method: string;
	orgId: string;
	path: string;
	result?: unknown;
	status: number;
	tenantUserId: string;
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
	screen: "findings" | "repositories" | "scans";
	tenantUserId: string;
}

interface SecurityProofApi {
	calls: () => SecurityRequestCall[];
	clearCalls: () => void;
	connected: () => boolean;
	failNext: (failure: FailureInjection) => void;
	mount: (input: MountInput) => void;
}

declare global {
	interface Window {
		__securityProof: SecurityProofApi;
	}
}

const calls: SecurityRequestCall[] = [];
const failures: FailureInjection[] = [];
let connected = false;
let root: Root | null = null;

function services(input: MountInput): HostServices {
	return {
		registerRoute: () => {
			throw new CapabilityError("ui.registerRoute is not available");
		},
		appRequest: async ({ body, method, path }) => {
			const requestMethod = method ?? "GET";
			const call: SecurityRequestCall = {
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

			const response = await fetch(`/__proof/security${path}`, {
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
						: "The local Security sidecar rejected the request."
				);
			}
			return appResponseValueSchema.parse(result);
		},
		listAgents: async () => [],
	};
}

function mount(input: MountInput): void {
	if (!(input.appHtml && input.tenantUserId)) {
		throw new Error(
			"Security proof needs its compiled bundle and local fixture."
		);
	}
	calls.length = 0;
	connected = false;
	const nonce = crypto.randomUUID();
	const granted: ReadonlySet<Capability> = capabilitiesFromGrants(GRANTS);
	const srcdoc = htmlCompanionSrcdoc(nonce, input.appHtml, PLUGIN_ID, {
		screen: input.screen,
	});
	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("Security proof is missing #host-root.");
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
			title: "Security proof",
		})
	);
}

window.__securityProof = {
	calls: () => structuredClone(calls),
	clearCalls: () => {
		calls.length = 0;
	},
	connected: () => connected,
	failNext: (failure) => failures.push(failure),
	mount,
};
document.body.setAttribute("data-harness-ready", "1");
