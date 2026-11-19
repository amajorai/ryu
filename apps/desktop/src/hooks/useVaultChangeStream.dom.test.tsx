import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { useVaultChangeStream } from "./useVaultChangeStream.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const target: ApiTarget = {
	token: "node-token",
	url: "https://vault-hook.fixture",
	userJwt: null,
};
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

const FRAME =
	'event: vault\ndata: {"action":"write","at":"2026-11-13T00:00:00Z","seq":1,"type":"kv-write"}\n\n';

function Watcher() {
	useVaultChangeStream(target);
	return null;
}

test("a vault change invalidates the vault queries; unmount closes the stream", async () => {
	let push: ((text: string) => void) | null = null;
	let streamSignal: AbortSignal | undefined;
	globalThis.fetch = Object.assign(
		(_input: RequestInfo | URL, init?: RequestInit) => {
			streamSignal = init?.signal ?? undefined;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					push = (text) => controller.enqueue(new TextEncoder().encode(text));
					streamSignal?.addEventListener("abort", () => controller.close());
				},
			});
			return Promise.resolve(
				new Response(body, { headers: { "content-type": "text/event-stream" } })
			);
		},
		{ preconnect: originalFetch.preconnect }
	);
	const client = new QueryClient();
	const invalidated: unknown[] = [];
	const original = client.invalidateQueries.bind(client);
	client.invalidateQueries = (filters, options) => {
		invalidated.push(filters?.queryKey);
		return original(filters, options);
	};
	const root = createRoot(document.createElement("div"));
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<Watcher />
			</QueryClientProvider>
		);
		await Bun.sleep(20);
	});
	expect(push).not.toBeNull();
	await act(async () => {
		push?.(FRAME);
		push?.(FRAME);
		await Bun.sleep(400);
	});
	expect(invalidated).toEqual([["vault"]]);
	await act(async () => {
		root.unmount();
		await Bun.sleep(10);
	});
	expect(streamSignal?.aborted).toBe(true);
});
