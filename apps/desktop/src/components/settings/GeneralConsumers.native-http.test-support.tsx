// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
// The shipping Memory and Privacy consumers, mounted against the peer, and the
// DOM helpers the GeneralConsumers suites drive them with.
import { expect } from "bun:test";
import { act, type ReactNode } from "react";
import type { Node } from "../../store/useNodeStore.ts";
import {
	bodyErrors,
	calls,
	type Exchange,
	errorText,
	fetchErrors,
	fixtureErrors,
	fixtureTimers,
	live,
	localConservation,
	memoryKeys,
	nativeClearTimeout,
	nativeSetTimeout,
	type PhysicalNode,
	privacyKeys,
	pulse,
	runtimeErrors,
	unexpectedDestinations,
	waiters,
} from "./GeneralConsumers.native-http-store.test-support.tsx";

export const { createRoot } = await import("react-dom/client");
export const { MemoryRouter } = await import("react-router-dom");
export const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
export const { I18nProvider } = await import("@ryu/i18n/react");
export const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
export const { sileo } = await import("sileo");
export const { MemoryTab } = await import("./MemoryTab.tsx");
export const { PrivacySettings } = await import("./PrivacySettings.tsx");
export const { useActiveNode } = await import("../../hooks/useActiveNode.ts");
export const { useNodeStore } = await import("../../store/useNodeStore.ts");
export const { AppSurfaceProvider } = await import(
	"../../contexts/app-surface-context.tsx"
);
export const { getMemorySettings } = await import("../../lib/api/memory.ts");
export const { isAnalyticsEnabled, isAnalyticsConfigured } = await import(
	"../../lib/analytics.ts"
);
export const { isCrashReportingEnabled, isCrashReportingConfigured } =
	await import("../../lib/crash.ts");
export const savedNodeState = useNodeStore.getState();
export const queryClient = new QueryClient();
export const first: Node = {
	name: "same-node",
	url: `${live.ownedOrigin}/a`,
	token: "general-peer-node-a",
	userJwt: "delegation-a",
};
export const sameNodeDifferentJwt: Node = { ...first, userJwt: "delegation-b" };
export const second: Node = {
	name: "different-node",
	url: `${live.ownedOrigin}/b`,
	token: "general-peer-node-b",
	userJwt: "delegation-b",
};
export function select(node: Node) {
	useNodeStore.setState({
		nodes: [node],
		localNodes: [],
		defaultNode: node.name,
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
		activeNodeOnline: null,
	});
}
export function ActiveNodeConsumer() {
	const node = useActiveNode();
	return (
		<output
			data-general-active-jwt={node.userJwt ?? ""}
			data-general-active-node={node.url}
		>
			{node.name}
		</output>
	);
}
export function activeNodeAcknowledged(node: Node) {
	const consumer = document.querySelector("[data-general-active-node]");
	return (
		consumer?.getAttribute("data-general-active-node") === node.url &&
		consumer.getAttribute("data-general-active-jwt") === node.userJwt
	);
}
export function observeDom() {
	live.domObserver = new MutationObserver(pulse);
	live.domObserver.observe(document.body, {
		subtree: true,
		attributes: true,
		childList: true,
		characterData: true,
	});
}
export async function waitFor(
	check: () => boolean,
	description: string,
	timeoutMs = 3000
) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(`No actual acknowledgment: ${description}`);
		}
		await new Promise<void>((resolve, reject) => {
			const wake = () => {
				nativeClearTimeout(timer);
				fixtureTimers.delete(timer);
				waiters.delete(wake);
				resolve();
			};
			const timer = nativeSetTimeout(
				() => {
					fixtureTimers.delete(timer);
					waiters.delete(wake);
					reject(new Error(`No actual acknowledgment: ${description}`));
				},
				Math.max(1, deadline - Date.now())
			);
			fixtureTimers.add(timer);
			waiters.add(wake);
			if (check()) {
				wake();
			}
		});
	}
}
export async function settledAct(check: () => boolean, description: string) {
	await act(async () => {
		await waitFor(check, description);
		await Promise.resolve();
	});
}
export async function consumeAll(marker = 0) {
	await settledAct(
		() =>
			live.activeHandlers === 0 &&
			live.activeFetches === 0 &&
			live.activeBodies === 0 &&
			calls
				.slice(marker)
				.every((entry) => entry.status !== null && entry.bodyConsumed),
		"every real server response/client body joined"
	);
}
export async function mount(content: ReactNode) {
	if (live.root !== null) {
		throw new Error("A real root is already mounted");
	}
	live.rootHost = document.createElement("div");
	document.body.append(live.rootHost);
	live.root = createRoot(live.rootHost, {
		onCaughtError: (error) => runtimeErrors.push(errorText(error)),
		onUncaughtError: (error) => runtimeErrors.push(errorText(error)),
		onRecoverableError: (error) => runtimeErrors.push(errorText(error)),
	});
	const actualRoot = live.root;
	await act(async () => {
		actualRoot.render(
			<QueryClientProvider client={queryClient}>
				<MemoryRouter>
					<AppSurfaceProvider surface="desktop">
						<I18nProvider
							autoLocalizeDom={false}
							initialLocale="en"
							initialPackId="official/en"
						>
							<ActiveNodeConsumer />
							{content}
							<Toaster />
						</I18nProvider>
					</AppSurfaceProvider>
				</MemoryRouter>
			</QueryClientProvider>
		);
	});
}
export async function unmount() {
	if (live.root !== null) {
		const actualRoot = live.root;
		live.root = null;
		await act(async () => {
			sileo.clear();
			actualRoot.unmount();
			await Promise.resolve();
		});
	}
	live.rootHost?.remove();
	live.rootHost = null;
	await consumeAll();
}
export function memorySwitch(label: string) {
	const control = document.querySelector<HTMLElement>(
		`[role="switch"][aria-label="${label}"]`
	);
	if (!control) {
		throw new Error(`Missing actual Memory switch ${label}`);
	}
	return control;
}
export function recallSwitch() {
	return memorySwitch("Automatically recall relevant context");
}
export function consentSwitch() {
	return memorySwitch("Include sensitive topics in memory");
}
export function checked(control: HTMLElement) {
	return control.getAttribute("aria-checked") === "true";
}
export function input(label: string) {
	const control = document.querySelector<HTMLInputElement>(
		`input[aria-label="${label}"]`
	);
	if (!control) {
		throw new Error(`Missing actual Memory input ${label}`);
	}
	return control;
}
export async function click(control: HTMLElement) {
	if (
		control.getAttribute("aria-disabled") === "true" ||
		control.hasAttribute("disabled")
	) {
		throw new Error("The genuine control is disabled");
	}
	await act(async () => {
		control.click();
		await Promise.resolve();
	});
}
export async function setDraft() {
	const draft = input("Search query");
	const nativeValueSetter = Object.getOwnPropertyDescriptor(
		window.HTMLInputElement.prototype,
		"value"
	)?.set;
	if (!nativeValueSetter) {
		throw new Error("Native input setter is missing");
	}
	await act(async () => {
		nativeValueSetter.call(draft, "unsent native draft");
		draft.dispatchEvent(new window.Event("input", { bubbles: true }));
		draft.focus();
	});
	return draft;
}
export async function memoryReads(node: Node, marker: number) {
	const physical = node.url === first.url ? "a" : "b";
	await settledAct(() => {
		const own = calls
			.slice(marker)
			.filter(
				(entry) =>
					entry.node === physical &&
					entry.jwt === node.userJwt &&
					entry.method === "GET" &&
					entry.bodyConsumed &&
					entry.status === 200
			);
		return (
			memoryKeys.every((key) =>
				own.some((entry) => entry.path === `/api/preferences/${key}`)
			) &&
			own.some((entry) => entry.path === "/api/memory/settings") &&
			own.some((entry) => entry.path === "/api/spaces")
		);
	}, "all genuine Memory reads for the selected exact authority");
	// A formerly selected write may legitimately remain held while the current
	// node's reads finish. Require every new selected response/body, not global
	// zero handlers, until that separately owned held response is released.
	await settledAct(
		() =>
			calls
				.slice(marker)
				.every((entry) => entry.status !== null && entry.bodyConsumed),
		"selected Memory response/body closure while an older write may remain held"
	);
}
export function privacySwitch() {
	const row = [
		...document.querySelectorAll<HTMLElement>('[data-slot="item"]'),
	].find(
		(entry) =>
			entry.querySelector('[data-slot="item-title"]')?.textContent?.trim() ===
			"Share anonymous usage analytics"
	);
	const control = row?.querySelector<HTMLElement>('[role="switch"]');
	if (!control) {
		throw new Error("Missing actual Privacy analytics switch");
	}
	return control;
}
export async function privacyReads(marker: number) {
	await settledAct(
		() =>
			privacyKeys.every((key) =>
				calls
					.slice(marker)
					.some(
						(entry) =>
							entry.node === "a" &&
							entry.jwt === first.userJwt &&
							entry.method === "GET" &&
							entry.path === `/api/preferences/${key}` &&
							entry.status === 200 &&
							entry.bodyConsumed
					)
			) &&
			calls
				.slice(marker)
				.some(
					(entry) =>
						entry.path === "/api/healing/config" &&
						entry.bodyConsumed &&
						entry.status === 200
				),
		"all actual Privacy preferences and healing bodies"
	);
	await consumeAll(marker);
}
export async function openUsagePage() {
	const button = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find((entry) => entry.textContent?.includes("Usage & crash data"));
	if (!button) {
		throw new Error("Missing actual Usage & crash data navigation");
	}
	await click(button);
}
export function expectLocalConserved() {
	for (const [key, value] of Object.entries(localConservation)) {
		expect(localStorage.getItem(key)).toBe(value);
	}
}
export function expectClean() {
	expect(fixtureErrors).toEqual([]);
	expect(runtimeErrors).toEqual([]);
	expect(unexpectedDestinations).toEqual([]);
	expect(fetchErrors).toEqual([]);
	expect(bodyErrors).toEqual([]);
	expect(live.activeHandlers).toBe(0);
	expect(live.activeFetches).toBe(0);
	expect(live.activeBodies).toBe(0);
	expect(
		calls.every((entry) => entry.status !== null && entry.bodyConsumed)
	).toBe(true);
	expect(fixtureTimers.size).toBe(0);
	expect(live.activeChild).toBeNull();
}
export function writesAfter(marker: number) {
	return calls.slice(marker).filter((entry) => entry.method === "PUT");
}
export function expectWrite(
	call: Exchange,
	node: PhysicalNode,
	jwt: string,
	path: string,
	body: unknown,
	status: number
) {
	expect({
		node: call.node,
		jwt: call.jwt,
		path: call.path,
		method: call.method,
		body: call.body,
		status: call.status,
		consumed: call.bodyConsumed,
	}).toEqual({ node, jwt, path, method: "PUT", body, status, consumed: true });
}
export function onlyWrite(marker: number) {
	const own = writesAfter(marker);
	expect(own.length).toBe(1);
	const call = own[0];
	if (!call) {
		throw new Error("Expected one genuine SDK write");
	}
	return call;
}
