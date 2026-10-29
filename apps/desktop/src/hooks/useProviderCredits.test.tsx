import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let node = { url: "https://node.test", token: "one", userJwt: "caller" };
mock.module("./useActiveNode.ts", () => ({ useActiveNode: () => node }));
const reads: Array<{
	signal: AbortSignal;
	resolve: <TValue>(value: TValue) => void;
}> = [];
mock.module("@/src/lib/api/provider-credits.ts", () => ({
	supportsProviderCredits: (id: string) => id === "openrouter",
	fetchProviderCredits: (
		_target: Parameters<
			typeof import("@/src/lib/api/provider-credits.ts").fetchProviderCredits
		>[0],
		_id: string,
		signal: AbortSignal
	) => new Promise((resolve) => reads.push({ signal, resolve })),
}));
const { useProviderCredits } = await import("./useProviderCredits.ts");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const root = createRoot(document.createElement("div"));
function Probe({ id }: { id: string }) {
	useProviderCredits(id);
	return null;
}
const render = async (id: string) => {
	await act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<Probe id={id} />
				<Probe id={id} />
			</QueryClientProvider>
		)
	);
	await act(async () => {
		await Bun.sleep(10);
	});
};
afterEach(async () => {
	await act(() => root.unmount());
	client.clear();
});
test("credit rows filter unsupported providers, share reads and separate credentials", async () => {
	await render("unsupported");
	expect(reads).toHaveLength(0);
	await render("openrouter");
	expect(reads).toHaveLength(1);
	await act(async () => {
		reads[0].resolve({ available: true, meters: [] });
		await Bun.sleep(10);
	});
	node = { ...node, token: "two" };
	await render("openrouter");
	expect(reads).toHaveLength(2);
	node = { ...node, userJwt: "next" };
	await render("openrouter");
	expect(reads).toHaveLength(3);
	expect(reads[1].signal.aborted).toBe(true);
	await render("unsupported");
	expect(reads[2].signal.aborted).toBe(true);
	expect(reads).toHaveLength(3);
});
