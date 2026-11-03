// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
// The shipping DefaultsSection and eval consumer mounted against the peer, and
// the helpers the DefaultsSection.consumer suites drive them with.
import { expect } from "bun:test";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { Node } from "@/src/store/useNodeStore.ts";
import {
	createRoot,
	server,
} from "./DefaultsSection.consumer.native-http-peer.test-support.tsx";
import {
	bodyReads,
	type Call,
	calls,
	entitlementKeys,
	live,
	localKey,
	type Owner,
	type Records,
	settleNativeTransport,
} from "./DefaultsSection.consumer.native-http-store.test-support.tsx";

export const { QueryClientProvider } = await import("@tanstack/react-query");
export const { MemoryRouter } = await import("react-router-dom");
export const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
export const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
export const { queryClient } = await import("@/src/lib/query-client.ts");
export const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
export const { useActiveNode } = await import("@/src/hooks/useActiveNode.ts");
export const { toTarget } = await import("@/src/lib/api/client.ts");
export const { nodeDefaultModelQueryKey, resolveNodeDefaultModel } =
	await import("@/src/hooks/useNodeDefaultModel.ts");
export const { getPreference, setLaneAgentSelection } = await import(
	"@/src/lib/api/preferences.ts"
);
export const { BACKEND_URL, vaultHydrated, TOKEN_KEY } = await import(
	"@/lib/auth-client.ts"
);
export const { DefaultsSection } = await import("./DefaultsSection.tsx");
export const { AgentEvalsView } = await import(
	"@/src/components/agents/AgentEvalsView.tsx"
);
await vaultHydrated;
export const originalNodeState = useNodeStore.getState();
export const rootTransportStarts = new WeakMap<Root, number>();
export const runtimeErrors: string[] = [];
export const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
export const onUnhandledRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onUnhandledRejection);

export function observedRoot(element: HTMLDivElement) {
	const mountedRoot = createRoot(element, {
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
	});
	rootTransportStarts.set(mountedRoot, live.nextCallId);
	return mountedRoot;
}

export function MountedSettings() {
	const node = useActiveNode();
	const target: ApiTarget = toTarget(node);
	const [draft, setDraft] = useState("Unsent defaults proof draft");
	return (
		<>
			<input
				aria-label="Unsent defaults proof draft"
				onChange={(event) => setDraft(event.target.value)}
				value={draft}
			/>
			<DefaultsSection canConfigure managed={false} target={target} />
			{live.showEvals ? (
				<div data-defaults-proof-evals="automatic">
					<AgentEvalsView
						agentId={null}
						defaultModel=""
						key={live.evalGeneration}
						target={target}
					/>
				</div>
			) : null}
			{live.showFreshRefusalEvals ? (
				<div data-defaults-proof-evals="fresh">
					<AgentEvalsView agentId={null} defaultModel="" target={target} />
				</div>
			) : null}
		</>
	);
}
export function tree() {
	return (
		<QueryClientProvider client={queryClient}>
			<MemoryRouter>
				<EntitlementProvider>
					<MountedSettings />
					<Toaster />
				</EntitlementProvider>
			</MemoryRouter>
		</QueryClientProvider>
	);
}
export async function until(predicate: () => boolean, reason: string) {
	const deadline = Date.now() + 4000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(reason);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}
export function currentNode(
	token = "defaults-a-bearer",
	userJwt = "defaults-a-jwt"
): Node {
	return {
		name: "defaults-proof",
		url: `${server.url.origin}/node`,
		token,
		userJwt,
	};
}
export async function setNode(node: Node) {
	await act(async () =>
		useNodeStore.setState({
			autoSelect: false,
			autoSelectedNode: null,
			defaultNode: node.name,
			nodes: [node],
		})
	);
}
export function localControl() {
	const element = document.querySelector<HTMLButtonElement>(
		'[aria-label="Default local agent or model"]'
	);
	if (!element) {
		throw new Error("Missing actual local model setting");
	}
	return element;
}
export function evalInput() {
	const element =
		live.container?.querySelector<HTMLInputElement>("#eval-model");
	if (!element) {
		throw new Error("Missing actual eval model consumer");
	}
	return element;
}
export function draftInput() {
	const element = live.container?.querySelector<HTMLInputElement>(
		'[aria-label="Unsent defaults proof draft"]'
	);
	if (!element) {
		throw new Error("Missing retained draft");
	}
	return element;
}
export function button(name: string) {
	const element = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find(
		(item) =>
			(item.getAttribute("aria-label") ?? item.textContent?.trim()) === name
	);
	if (!element) {
		throw new Error(`Missing actual action ${name}`);
	}
	return element;
}
export async function chooseCustomModel(model: string) {
	await act(async () => localControl().click());
	await until(
		() => document.querySelector('[aria-label="Custom model id"]') !== null,
		"Actual custom model field did not open"
	);
	const input = document.querySelector<HTMLInputElement>(
		'[aria-label="Custom model id"]'
	)!;
	await act(async () => {
		input.focus();
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, model);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () =>
		input.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				code: "Enter",
				bubbles: true,
				cancelable: true,
			})
		)
	);
}
export async function mount() {
	expect(BACKEND_URL).toBe(server.url.origin);
	live.container = document.createElement("div");
	document.body.append(live.container);
	live.root = observedRoot(live.container);
	await act(async () => live.root!.render(tree()));
	await until(
		() =>
			document.querySelector('[aria-label="Default local agent or model"]') !==
				null &&
			calls.filter(
				(call) =>
					entitlementKeys.has(
						new URL(call.url).pathname.split("/").at(-1) ?? ""
					) && call.status === 200
			).length >= 2 &&
			live.activeHandlers === 0 &&
			evalInput().value === "model-a",
		"Actual saved defaults and model consumer did not finish initial reads"
	);
}
export async function unmount() {
	const cleanupErrors: unknown[] = [];
	if (live.root) {
		const mountedRoot = live.root;
		const start = rootTransportStarts.get(mountedRoot);
		try {
			if (start === undefined) {
				throw new Error("Missing actual renderer transport start");
			}
			// This genuine provider publishes two mirrors sequentially after
			// becoming ready. Await both SDK-consumed HTTP acknowledgments before
			// ending its lifetime; an empty fetch set can precede the second call.
			await until(
				() =>
					[...entitlementKeys].every((key) =>
						calls.some(
							(call) =>
								call.id > start &&
								call.method === "PUT" &&
								new URL(call.url).pathname.endsWith(`/${key}`) &&
								call.status === 200 &&
								acknowledged(call)?.text === JSON.stringify({ ok: true, key })
						)
					),
				"Actual renderer entitlement mirrors did not consume both native acknowledgments"
			);
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			await act(async () => {
				mountedRoot.unmount();
				await settleNativeTransport();
			});
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	live.root = null;
	live.container?.remove();
	live.container = null;
	if (cleanupErrors.length) {
		throw new AggregateError(cleanupErrors, "Actual renderer teardown failed");
	}
}
export async function newlyOpenEvals() {
	live.showEvals = false;
	await act(async () => live.root!.render(tree()));
	expect(live.container?.querySelector("#eval-model")).toBeNull();
	live.evalGeneration += 1;
	live.showEvals = true;
	await act(async () => live.root!.render(tree()));
}
export function acknowledged(call: Call) {
	return bodyReads.find(
		(read) => read.id === call.id && read.status === call.status
	);
}
export function localWrites() {
	return calls.filter(
		(call) =>
			call.method === "PUT" &&
			new URL(call.url).pathname.endsWith(`/${localKey}`)
	);
}
export async function assertIndependentForeignDefault(expected: Records) {
	const target: ApiTarget = {
		url: `${server.url.origin}/foreign`,
		token: "defaults-foreign-bearer",
		userJwt: "defaults-foreign-jwt",
	};
	const before = calls.length;
	expect(await getPreference(target, localKey)).toBe(
		expected.foreign[localKey]
	);
	const read = calls
		.slice(before)
		.find((call) => call.url === `${target.url}/api/preferences/${localKey}`)!;
	expect(read).toMatchObject({
		owner: "foreign",
		method: "GET",
		bearer: "Bearer defaults-foreign-bearer",
		delegation: "defaults-foreign-jwt",
		body: null,
		status: 200,
	});
	expect(acknowledged(read)?.text).toBe(
		JSON.stringify({ key: localKey, value: expected.foreign[localKey] })
	);
}
export async function assertActualEvalRequest(owner: Owner, model: string) {
	const before = calls.length;
	await act(async () => button("Run evals").click());
	await until(
		() =>
			calls
				.slice(before)
				.some(
					(call) =>
						call.url.endsWith("/api/gateway/evals/run") &&
						acknowledged(call) !== undefined
				),
		"Actual eval run did not consume its native HTTP refusal"
	);
	const run = calls
		.slice(before)
		.find((call) => call.url.endsWith("/api/gateway/evals/run"))!;
	expect(run).toMatchObject({
		owner,
		method: "POST",
		body: {
			agent_id: null,
			model,
			dataset: [],
			evaluators: [],
			code_evaluators: [],
		},
		status: 503,
	});
	expect(acknowledged(run)?.text).toBe(
		JSON.stringify({ error: "Owned inference provider unavailable" })
	);
	await until(
		() => live.container!.textContent!.includes("503"),
		"Actual eval error consumer did not render HTTP503"
	);
	expect(button("Run evals").disabled).toBe(false);
}
export async function assertUnmountedQueries() {
	await unmount();
	const queries = queryClient.getQueryCache().findAll();
	expect(queries.every((query) => query.getObserversCount() === 0)).toBe(true);
	const before = calls.length;
	await act(async () => {
		await queryClient.invalidateQueries();
		await Bun.sleep(25);
	});
	expect(calls).toHaveLength(before);
	expect(live.activeHandlers).toBe(0);
	expect(runtimeErrors).toEqual([]);
}
