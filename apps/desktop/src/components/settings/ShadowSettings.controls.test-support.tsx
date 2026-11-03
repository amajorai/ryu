import { afterAll, afterEach, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
	calls,
	capturePath,
	configPath,
	contributionsPath,
	egress,
	inFlight,
	nativeFetch,
	nodeToken,
	previousCoreUrl,
	proofDirectory,
	resetShadowPeer,
	server,
	unexpected,
} from "./ShadowSettings.controls-peer.test-support.ts";

const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { ShadowSettings } = await import("./ShadowSettings.tsx");
const originalNodeState = useNodeStore.getState();

let root: Root | null = null;
let client: InstanceType<typeof QueryClient> | null = null;
let container: HTMLDivElement;

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
export async function settle() {
	await until(
		() => inFlight === 0 && calls.every((call) => call.completed),
		"Owned native requests did not settle"
	);
	await act(async () => {
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	});
}
/** The shipping row whose title is `title`, as SettingsItem renders it. */
function row(title: string): HTMLElement {
	const heading = [
		...container.querySelectorAll<HTMLElement>('[data-slot="item-title"]'),
	].find((item) => item.textContent?.trim() === title);
	const item = heading?.closest<HTMLElement>('[data-slot="item"]');
	if (!item) {
		throw new Error(`Missing shipping settings row ${title}`);
	}
	return item;
}
export function rowInput(title: string): HTMLInputElement {
	const inputs = row(title).querySelectorAll<HTMLInputElement>(
		'input:not([aria-hidden="true"])'
	);
	if (inputs.length !== 1 || !inputs[0]) {
		throw new Error(`Row ${title} must own exactly one visible input`);
	}
	return inputs[0];
}
/** The caption SettingsItem renders below the card that holds the row. */
/** A flush settings row renders its description under its own title. */
export function rowDescription(title: string): string {
	return (
		row(title).querySelector('[data-slot="item-title"]')?.nextElementSibling
			?.textContent ?? ""
	);
}
export function rowTrigger(title: string): HTMLElement {
	const trigger = row(title).querySelector<HTMLElement>('[role="combobox"]');
	if (!trigger) {
		throw new Error(`Row ${title} has no select trigger`);
	}
	return trigger;
}
export function hasRow(title: string) {
	return [
		...container.querySelectorAll<HTMLElement>('[data-slot="item-title"]'),
	].some((item) => item.textContent?.trim() === title);
}
export function button(name: string) {
	const element = [
		...container.querySelectorAll<HTMLButtonElement>("button"),
	].find((item) => item.textContent?.trim() === name);
	if (!element) {
		throw new Error(`Missing shipping action ${name}`);
	}
	return element;
}
/** The policy Save action, whether idle ("Save …") or busy ("Saving…"). */
function saveButton() {
	return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) =>
			["Save computer-use settings", "Saving…"].includes(
				item.textContent?.trim() ?? ""
			)
	);
}
export async function type(element: HTMLInputElement, value: string) {
	await act(async () => {
		element.focus();
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
export async function choose(trigger: HTMLElement, label: string) {
	await act(async () => trigger.click());
	await until(
		() => trigger.getAttribute("aria-expanded") === "true",
		"Select popup did not open"
	);
	const options = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].filter((item) => item.textContent?.trim() === label);
	if (options.length !== 1 || !options[0]) {
		throw new Error(`Expected one shipping option ${label}`);
	}
	const option = options[0];
	await act(async () => option.click());
	await until(
		() => trigger.getAttribute("aria-expanded") === "false",
		"Select popup did not close"
	);
}
export function policyWrites() {
	return calls.filter(
		(call) => call.path === configPath && call.method === "POST"
	);
}
export function captureWrites() {
	return calls.filter(
		(call) => call.path === capturePath && call.method === "POST"
	);
}
export function section(title: string) {
	const heading = [...container.querySelectorAll("h3")].find(
		(item) => item.textContent?.trim() === title
	);
	const element = heading?.parentElement?.parentElement;
	if (!element) {
		throw new Error(`Missing ${title} section`);
	}
	return element;
}
export async function save() {
	const before = policyWrites().length;
	await act(async () => button("Save computer-use settings").click());
	await until(
		() =>
			policyWrites().length === before + 1 &&
			policyWrites().every((call) => call.completed) &&
			saveButton()?.textContent?.trim() === "Save computer-use settings" &&
			!saveButton()?.disabled,
		"Computer-use save did not reach a settled UI"
	);
	await settle();
	return policyWrites().at(-1);
}
export async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client!}>
				<ShadowSettings />
			</QueryClientProvider>
		)
	);
	await until(
		() =>
			container.textContent?.includes("Computer use") === true &&
			!container.textContent.includes("Loading computer-use settings") &&
			calls.some(
				(call) =>
					call.path === capturePath && call.method === "POST" && call.completed
			) &&
			calls.some((call) => call.path === contributionsPath && call.completed),
		"Shipping Shadow settings did not finish loading"
	);
	await settle();
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

/** Registers the per-case setup and closure checks every split file shares. */
export function registerShadowControlsHooks() {
	beforeEach(() => {
		resetShadowPeer();
		const local = {
			name: "local-controls",
			url: server.url.origin,
			token: nodeToken,
			userJwt: null,
		};
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
	});
	afterEach(async () => {
		await unmount();
		await until(
			() => inFlight === 0 && calls.every((call) => call.completed),
			"Owned requests remain at teardown"
		);
		if (unexpected.length > 0 || egress.length > 0) {
			throw new Error(
				`Undeclared requests or egress: ${JSON.stringify({ unexpected, egress })}`
			);
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
		rmSync(proofDirectory, { recursive: true, force: true });
	});
}
