import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const reads: Array<{
	signal: AbortSignal;
	resolve: <TValue>(value: TValue) => void;
}> = [];
const writes: Array<{ target: ApiTarget; resolve: () => void }> = [];
mock.module("@/src/lib/api/capability-layers.ts", () => ({
	fetchCapabilityLayers: (_target: ApiTarget, signal: AbortSignal) =>
		new Promise((resolve) => reads.push({ signal, resolve })),
	setCapabilityBinding: (target: ApiTarget) =>
		new Promise<void>((resolve) => writes.push({ target, resolve })),
}));
const { useCapabilityLayers } = await import("./useCapabilityLayers.ts");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
});
const root = createRoot(document.createElement("div"));
let latest: ReturnType<typeof useCapabilityLayers>;
function Probe({ target }: { target: ApiTarget }) {
	latest = useCapabilityLayers(target, true);
	return null;
}
const tick = async (action: () => void) => {
	await act(() => action());
	await act(async () => {
		await Bun.sleep(10);
	});
};
const render = (target: ApiTarget) =>
	tick(() =>
		root.render(
			<QueryClientProvider client={client}>
				<Probe target={target} />
				<Probe target={target} />
			</QueryClientProvider>
		)
	);
const provider = {
	id: "fixture",
	name: "Fixture",
	version: "1",
	isDefault: true,
	target: null,
	verbs: [],
	servesRoute: true,
	servesVerbs: false,
};
const model = {
	capabilities: [
		{
			capability: "web.search",
			toolkit: true,
			decisionModel: false,
			selectable: true,
			available: [],
			providers: [provider],
			bound: "fixture",
			overridden: false,
			title: "Search",
		},
		{
			available: [],
			bound: null,
			capability: "decision.typed",
			decisionModel: true,
			overridden: false,
			providers: [],
			selectable: true,
			title: "Decision Models",
			toolkit: false,
		},
		{ capability: "private", toolkit: false },
		{
			available: [],
			bound: "com.acme.tunnel",
			capability: "network.tunnel",
			decisionModel: false,
			overridden: false,
			providers: [{ ...provider, id: "com.acme.tunnel", name: "Acme Tunnel" }],
			selectable: true,
			title: "Tunnel",
			toolkit: false,
		},
	],
	verbs: [],
};
afterEach(async () => {
	await act(() => root.unmount());
	client.clear();
});
test("capability reads share credentials and a completed old-node selection invalidates only its own scope", async () => {
	const a = { url: "https://node.test", token: "one", userJwt: "caller" };
	const b = { ...a, token: "two" };
	await render(a);
	expect(reads).toHaveLength(1);
	await tick(() => reads[0].resolve(model));
	expect(latest.layers).toHaveLength(1);
	expect(latest.layers[0].boundProvider?.id).toBe("fixture");
	expect(latest.decisionModels).toHaveLength(1);
	expect(latest.decisionModels[0].capability).toBe("decision.typed");
	// Plugin tunnels live in the VPN layer, never as a Toolkit row.
	expect(latest.tunnel?.boundProvider?.name).toBe("Acme Tunnel");
	expect(latest.layers.some((l) => l.capability === "network.tunnel")).toBe(
		false
	);
	let selection: Promise<void> = Promise.resolve();
	await tick(() => {
		selection = latest.select("web.search", "next");
	});
	expect(writes[0].target).toEqual(a);
	await render(b);
	expect(reads).toHaveLength(2);
	await tick(() => reads[1].resolve(model));
	await act(async () => {
		writes[0].resolve();
		await selection;
	});
	expect(reads).toHaveLength(2);
	expect(
		client.getQueryState(["node-capability-layers", a.url, a.token, a.userJwt])
			?.isInvalidated
	).toBe(true);
	await render(a);
	expect(reads).toHaveLength(3);
	await act(() => root.render(null));
	expect(reads[2].signal.aborted).toBe(true);
});
