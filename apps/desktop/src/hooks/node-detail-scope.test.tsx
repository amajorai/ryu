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
const reads: string[] = [];
const read = (kind: string, target: ApiTarget) => {
	const scope = `${kind}:${target.token}:${target.userJwt}`;
	reads.push(scope);
	return Promise.resolve({ scope });
};
mock.module("@/src/lib/api/system.ts", () => ({
	fetchSystemInfo: (target: ApiTarget) => read("hardware", target),
}));
mock.module("@/src/lib/api/sandboxes.ts", () => ({
	fetchNodeSandboxes: (target: ApiTarget) => read("sandboxes", target),
}));
const { useNodeSystemInfo } = await import("./useNodeSystemInfo.ts");
const { useNodeSandboxes } = await import("./useNodeSandboxes.ts");
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const container = document.createElement("div");
const root = createRoot(container);
let latest: unknown[] = [];
function Probe({ target }: { target: ApiTarget }) {
	const hardware = useNodeSystemInfo(target, true);
	const sandboxes = useNodeSandboxes(target, true);
	latest = [hardware.data, sandboxes.data];
	return null;
}
afterEach(async () => {
	await act(() => root.unmount());
	client.clear();
});
test("node details remain shared within credentials and refresh across token or caller changes", async () => {
	for (const [index, target] of [
		{ url: "https://node.test", token: "a", userJwt: "one" },
		{ url: "https://node.test", token: "b", userJwt: "one" },
		{ url: "https://node.test", token: "b", userJwt: "two" },
	].entries()) {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<Probe target={target} />
					<Probe target={target} />
				</QueryClientProvider>
			);
		});
		await act(async () => {
			await Bun.sleep(10);
		});
		expect(reads).toHaveLength((index + 1) * 2);
		expect(latest).toEqual([
			{ scope: `hardware:${target.token}:${target.userJwt}` },
			{ scope: `sandboxes:${target.token}:${target.userJwt}` },
		]);
	}
});
