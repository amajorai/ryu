// Shared harness for the ShadowSettings.native-http suites: the shipping
// component mounted against the peer in ShadowSettings.native-http-peer.
import { afterAll, afterEach, beforeEach } from "bun:test";
import { fileURLToPath } from "node:url";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
	type Config,
	calls,
	clientReads,
	configPath,
	egress,
	inFlight,
	nativeFetch,
	nodeToken,
	previousCoreUrl,
	releaseHeld,
	resetShadowPeer,
	saved,
	secretListPath,
	server,
	takeHeldRelease,
	unexpected,
} from "./ShadowSettings.native-http-peer.test-support.ts";

let root: Root | null = null;
let client: InstanceType<typeof QueryClient> | null = null;
export let container: HTMLDivElement;
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
export const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const componentSource =
	process.env.RYU_SHADOW_SETTINGS_PROOF_SOURCE ??
	fileURLToPath(new URL("./ShadowSettings.tsx", import.meta.url));
const { ShadowSettings } = await import(componentSource);
export const { getShadowComputerUseConfig } = await import(
	"@/src/lib/api/shadow.ts"
);
export const { listPluginSecrets } = await import(
	"@/src/lib/api/plugin-secrets.ts"
);
const originalNodeState = useNodeStore.getState();
export const target = {
	url: server.url.origin,
	token: nodeToken,
	userJwt: null,
};

export async function until(check: () => boolean, message: string) {
	const deadline = Date.now() + 2500;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 5));
		});
	}
}
export function computerUseSection() {
	const heading = [...container.querySelectorAll("h3")].find(
		(item) => item.textContent?.trim() === "Computer use"
	);
	const section = heading?.parentElement?.parentElement;
	if (!section) {
		throw new Error("Missing actual Computer use settings section");
	}
	return section;
}
export function computerUseAlert() {
	return computerUseSection().querySelector('[role="alert"]');
}
export async function retryComputerUse() {
	const retry = [
		...computerUseSection().querySelectorAll<HTMLButtonElement>("button"),
	].find((item) => item.textContent?.trim() === "Retry");
	if (!retry) {
		throw new Error("Missing explicit Computer use Retry action");
	}
	await act(async () => retry.click());
}
export function input(name: string) {
	const element = container.querySelector<HTMLInputElement>(
		`input[aria-label="${name}"]`
	);
	if (!element) {
		throw new Error(`Missing shipping input ${name}`);
	}
	return element;
}
export function maybeButton(name: string) {
	return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.textContent?.trim() === name
	);
}
export function button(name: string) {
	const element = maybeButton(name);
	if (!element) {
		throw new Error(`Missing shipping action ${name}`);
	}
	return element;
}
export async function edit(name: string, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input(name), value);
		input(name).dispatchEvent(new Event("input", { bubbles: true }));
	});
}
export async function click(name: string) {
	await act(async () => button(name).click());
}
export async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	root = createRoot(container);
	await act(async () =>
		root!.render(
			<QueryClientProvider client={client!}>
				<ShadowSettings />
			</QueryClientProvider>
		)
	);
}
export async function unmount() {
	await act(async () => {
		root?.unmount();
		root = null;
	});
	client?.clear();
	client = null;
	container?.remove();
}
export async function loaded() {
	await until(() => {
		const configRead = clientReads
			.filter((read) => read.path === configPath && read.method === "GET")
			.at(-1);
		const metadataRead = clientReads
			.filter((read) => read.path === secretListPath && read.method === "GET")
			.at(-1);
		return (
			configRead?.status === 200 &&
			configRead.bodyConsumed &&
			metadataRead?.status === 200 &&
			metadataRead.bodyConsumed &&
			// The page can still read "Loading…" a tick after the bodies land, so
			// look the controls up without throwing and keep polling.
			maybeButton("Save computer-use settings")?.disabled === false &&
			container.querySelector<HTMLInputElement>(
				'input[aria-label="Maximum computer-use steps"]'
			)?.value === String(saved.maxSteps)
		);
	}, "Actual saved config and credential metadata bodies did not reach ready UI");
}
export function writes(path = configPath, method = "POST") {
	return calls.filter((call) => call.path === path && call.method === method);
}
export async function release() {
	const resolve = takeHeldRelease();
	if (!resolve) {
		throw new Error("No held actual native request");
	}
	await act(async () => resolve());
}
export async function physicalRead() {
	const response = await nativeFetch(server.url.origin + configPath, {
		headers: { Authorization: `Bearer ${nodeToken}` },
	});
	if (response.status !== 200) {
		throw new Error(`Independent HTTP read refused: ${response.status}`);
	}
	return response.json();
}
export function editable(config: Config) {
	const { applied, jevApiKeyConfigured, ...value } = config;
	return value;
}

/** The per-test reset and teardown every ShadowSettings.native-http suite uses. */
export function registerShadowSettingsHooks() {
	beforeEach(() => {
		resetShadowPeer();
		const local = { name: "local-regression", ...target };
		const remote = {
			name: "selected-remote",
			url: "https://unowned-selected-remote.example.test",
			token: "remote-only",
			userJwt: null,
		};
		useNodeStore.setState({
			nodes: [local, remote],
			localNodes: [local, remote],
			cloudNodes: [],
			defaultNode: remote.name,
			autoSelect: false,
			autoSelectedNode: null,
			tabOverrides: {},
		});
		if (useNodeStore.getState().getActiveNode().name !== remote.name) {
			throw new Error("Unrelated remote must be selected");
		}
	});
	afterEach(async () => {
		if (releaseHeld) {
			await release();
		}
		await unmount();
		await until(
			() => inFlight === 0 && calls.every((call) => call.completed),
			"Owned native requests remain during teardown"
		);
		if (unexpected.length > 0) {
			throw new Error(`Unexpected HTTP: ${JSON.stringify(unexpected)}`);
		}
		if (egress.length > 0) {
			throw new Error(`Unexpected egress: ${JSON.stringify(egress)}`);
		}
		if (calls.some((call) => /\/api\/(?:sidecar|setup)/.test(call.path))) {
			throw new Error("Unexpected sidecar/setup operation");
		}
	});
	afterAll(async () => {
		useNodeStore.setState(originalNodeState);
		globalThis.fetch = nativeFetch;
		if (previousCoreUrl === undefined) {
			delete process.env.VITE_CORE_URL;
		} else {
			process.env.VITE_CORE_URL = previousCoreUrl;
		}
		await server.stop(true);
	});
}
