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

const PLUGIN_ID = "@ryu/pull-requests";
const GRANTS = ["app:http", "shell:integrate"];

interface PullRequestsCall {
	body?: unknown;
	method: string;
	path: string;
	result?: unknown;
	status: number;
}

interface MountInput {
	appHtml: string;
	assistantGrant?: boolean;
	/** App request paths held from the first frame load until released. */
	holdPaths?: string[];
	view: "issues" | "pulls";
}

/** One write the desktop's global Ask Ryu assistant received from the app,
 *  after the real host bridge validated and clamped it. */
export type AssistantCall =
	| {
			method: "publishContext";
			input: Parameters<
				NonNullable<HostServices["assistantPublishContext"]>
			>[0];
	  }
	| {
			method: "registerSurface";
			input: Parameters<
				NonNullable<HostServices["assistantRegisterSurface"]>
			>[0];
	  }
	| {
			method: "open";
			input: Parameters<NonNullable<HostServices["assistantOpen"]>>[0];
	  }
	| { method: "clearContext" }
	| { method: "clearSurface" };

/** Every RPC the companion frame sent over the host port, granted or not. */
export interface BridgeRpc {
	error?: string;
	id: number;
	method: string;
	outcome: "pending" | "resolved" | "rejected";
}

export interface PullRequestsProofApi {
	assistantCalls: () => AssistantCall[];
	bridgeRpcs: () => BridgeRpc[];
	calls: () => PullRequestsCall[];
	clearCalls: () => void;
	connected: () => boolean;
	holdRequest: (path: string) => void;
	mount: (input: MountInput) => void;
	openedExternal: () => string[];
	releaseRequest: (path: string) => void;
}

declare global {
	interface Window {
		__pullRequestsProof: PullRequestsProofApi;
	}
}

const calls: PullRequestsCall[] = [];
const openedExternal: string[] = [];
let connected = false;
let root: Root | null = null;
const assistantCalls: AssistantCall[] = [];
const bridgeRpcs: BridgeRpc[] = [];
const heldRequests = new Map<
	string,
	{ promise: Promise<void>; release: () => void }
>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function recordRpcRequest(request: unknown): void {
	if (
		isRecord(request) &&
		request.kind === "ryu-plugin-rpc" &&
		typeof request.id === "number" &&
		typeof request.method === "string"
	) {
		bridgeRpcs.push({
			id: request.id,
			method: request.method,
			outcome: "pending",
		});
	}
}

function recordRpcResult(message: unknown): void {
	if (
		!(
			isRecord(message) &&
			message.kind === "ryu-plugin-rpc-result" &&
			typeof message.id === "number"
		)
	) {
		return;
	}
	const rpc = [...bridgeRpcs].reverse().find((item) => item.id === message.id);
	if (!rpc) {
		return;
	}
	if ("error" in message) {
		rpc.outcome = "rejected";
		rpc.error =
			typeof message.error === "string"
				? message.error
				: JSON.stringify(message.error);
	} else {
		rpc.outcome = "resolved";
	}
}

// Observe the real ExtensionHost port (it is the only MessageChannel this page
// creates) so the proof sees every RPC the frame attempts — including ones the
// capability gate denies before any host service runs — and how each settled.
function observeBridgePort(port: MessagePort): void {
	port.addEventListener("message", (event: MessageEvent<unknown>) =>
		recordRpcRequest(event.data)
	);
	const post = port.postMessage.bind(port);
	const observedPost = (
		message: unknown,
		options?: StructuredSerializeOptions | Transferable[]
	): void => {
		recordRpcResult(message);
		if (Array.isArray(options)) {
			post(message, options);
		} else {
			post(message, options);
		}
	};
	port.postMessage = observedPost;
}

const NativeMessageChannel = window.MessageChannel;
window.MessageChannel = class ObservedMessageChannel extends (
	NativeMessageChannel
) {
	constructor() {
		super();
		observeBridgePort(this.port1);
	}
};

async function waitForHeldRequest(path: string): Promise<void> {
	await heldRequests.get(path)?.promise;
}

function holdRequest(path: string): void {
	if (heldRequests.has(path)) {
		return;
	}
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	heldRequests.set(path, { promise, release });
}

function releaseHeldRequests(): void {
	for (const held of heldRequests.values()) {
		held.release();
	}
	heldRequests.clear();
}

function services(): HostServices {
	return {
		// The desktop shell (PluginHostPanel) feeds these into the ONE global Ask
		// Ryu assistant; the proof records exactly what reached that boundary.
		assistantPublishContext: async (input) => {
			assistantCalls.push({
				method: "publishContext",
				input: structuredClone(input),
			});
		},
		assistantClearContext: async () => {
			assistantCalls.push({ method: "clearContext" });
		},
		assistantRegisterSurface: async (input) => {
			assistantCalls.push({
				method: "registerSurface",
				input: structuredClone(input),
			});
		},
		assistantClearSurface: async () => {
			assistantCalls.push({ method: "clearSurface" });
		},
		assistantOpen: async (input) => {
			assistantCalls.push({ method: "open", input: structuredClone(input) });
		},
		registerRoute: () => {
			throw new CapabilityError("ui.registerRoute is not available");
		},
		listAgents: () => {
			throw new CapabilityError("core.listAgents is not available");
		},
		appRequest: async ({ body, method, path }) => {
			const requestMethod = method ?? "GET";
			const call: PullRequestsCall = {
				...(body === undefined
					? undefined
					: { body: parseProofJson(JSON.stringify(body)) }),
				method: requestMethod,
				path,
				status: 0,
			};
			calls.push(call);
			await waitForHeldRequest(path);
			const response = await fetch(`/__proof/pull-requests${path}`, {
				method: requestMethod,
				headers:
					body === undefined ? {} : { "content-type": "application/json" },
				...(body === undefined ? undefined : { body: JSON.stringify(body) }),
			});
			const result = await response.json().catch(() => null);
			call.status = response.status;
			call.result = structuredClone(result);
			if (!response.ok) {
				const message =
					isNativeObjectLike(result) && isNativeText(result.error)
						? result.error
						: "The local Pull Requests sidecar rejected the request.";
				throw new Error(message);
			}
			return appResponseValueSchema.parse(result);
		},
		openExternal: async ({ href }) => {
			openedExternal.push(href);
		},
	};
}

function mount(input: MountInput): void {
	if (!input.appHtml) {
		throw new Error("Pull Requests proof requires its compiled app bundle.");
	}
	calls.length = 0;
	openedExternal.length = 0;
	assistantCalls.length = 0;
	bridgeRpcs.length = 0;
	releaseHeldRequests();
	for (const heldPath of input.holdPaths ?? []) {
		holdRequest(heldPath);
	}
	connected = false;
	const nonce = crypto.randomUUID();
	const granted: ReadonlySet<Capability> = capabilitiesFromGrants(
		input.assistantGrant ? [...GRANTS, "assistant:context"] : GRANTS
	);
	const srcdoc = htmlCompanionSrcdoc(nonce, input.appHtml, PLUGIN_ID, {
		view: input.view,
	});
	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("Pull Requests proof is missing #host-root.");
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
			title: "Pull Requests proof",
		})
	);
}

window.__pullRequestsProof = {
	assistantCalls: () => structuredClone(assistantCalls),
	bridgeRpcs: () => structuredClone(bridgeRpcs),
	calls: () => structuredClone(calls),
	clearCalls: () => {
		calls.length = 0;
	},
	connected: () => connected,
	holdRequest,
	mount,
	openedExternal: () => [...openedExternal],
	releaseRequest: (path) => {
		const held = heldRequests.get(path);
		if (!held) {
			throw new Error(`No held proof request ${path}.`);
		}
		heldRequests.delete(path);
		held.release();
	},
};

document.body.setAttribute("data-harness-ready", "1");
