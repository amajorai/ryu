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
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const reads: Array<{
	signal: AbortSignal;
	resolve: <TValue>(value: TValue) => void;
}> = [];
const read = (_target: ApiTarget, _id: string, signal: AbortSignal) =>
	new Promise((resolve) => reads.push({ signal, resolve }));
mock.module("@/src/lib/query-client.ts", () => ({ queryClient: client }));
mock.module("@/src/lib/api/git.ts", () => ({
	fetchGitStatus: read,
	fetchWorktreeStatus: read,
	fetchWorktreeDiff: read,
}));
const {
	useGitStatus,
	useWorktreeStatus,
	useWorktreeDiff,
	invalidateGitStatus,
	invalidateWorktreeStatus,
	invalidateWorktreeDiff,
} = await import("./useGitStatus.ts");
const root = createRoot(document.createElement("div"));
function Probe({ target, cwd }: { target: ApiTarget; cwd: string }) {
	useGitStatus(target, cwd);
	useWorktreeStatus(target, "thread");
	useWorktreeDiff(target, "thread");
	return null;
}
const render = async (target: ApiTarget) => {
	await act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<Probe cwd="/workspace" target={target} />
				<Probe cwd="/workspace/" target={target} />
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
test("Git and worktree queries share canonical paths within a node scope and cancel obsolete scopes", async () => {
	const targets = [
		{ url: "https://a.test", token: "one", userJwt: "caller" },
		{ url: "https://b.test", token: "one", userJwt: "caller" },
		{ url: "https://b.test", token: "two", userJwt: "caller" },
		{ url: "https://b.test", token: "two", userJwt: "next" },
	];
	for (const [index, target] of targets.entries()) {
		await render(target);
		expect(reads).toHaveLength((index + 1) * 3);
		if (index > 0) {
			expect(
				reads
					.slice((index - 1) * 3, index * 3)
					.every((item) => item.signal.aborted)
			).toBe(true);
		}
	}
	await act(async () => {
		for (const item of reads.slice(-3)) {
			item.resolve({});
		}
		await Bun.sleep(10);
	});
	await act(async () => {
		invalidateGitStatus("/workspace/");
		invalidateWorktreeStatus("thread");
		invalidateWorktreeDiff("thread");
		await Bun.sleep(10);
	});
	expect(reads).toHaveLength(15);
});
