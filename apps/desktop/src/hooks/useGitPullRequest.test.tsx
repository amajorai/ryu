import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { GitPullRequest } from "@/src/lib/api/pull-requests.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const reads: Array<{
	signal: AbortSignal;
	resolve: (value: GitPullRequest | null) => void;
}> = [];
mock.module("@/src/lib/query-client.ts", () => ({ queryClient: client }));
mock.module("./useGitStatus.ts", () => ({
	canonicalCwd: (cwd: string) => cwd.trim(),
}));
mock.module("@/src/lib/api/pull-requests.ts", () => ({
	fetchPullRequestForBranch: (
		_target: ApiTarget,
		_cwd: string,
		_branch: string,
		signal: AbortSignal
	) =>
		new Promise<GitPullRequest | null>((resolve) =>
			reads.push({ signal, resolve })
		),
	// Linked pull request reads belong to other hooks in the module; these
	// branch-lookup tests never mount them.
	fetchPullRequestByUrl: () => Promise.reject(new Error("unused")),
	fetchPullRequestFeedback: () => Promise.reject(new Error("unused")),
	gitPullRequestStatus: () => null,
}));
const { useGitPullRequest, invalidateGitPullRequest } = await import(
	"./useGitPullRequest.ts"
);
const root = createRoot(document.createElement("div"));
function Probe({ target, enabled }: { target: ApiTarget; enabled: boolean }) {
	useGitPullRequest(target, "/workspace", "main", enabled);
	return null;
}
const render = async (target: ApiTarget, enabled: boolean) => {
	await act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<Probe enabled={enabled} target={target} />
				<Probe enabled={enabled} target={target} />
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
test("PR reads share warm results, isolate node credentials, cancel inactive work and invalidate by branch", async () => {
	const a = { url: "https://a.test", token: "one", userJwt: "caller" };
	await render(a, false);
	expect(reads).toHaveLength(0);
	await render(a, true);
	expect(reads).toHaveLength(1);
	await act(async () => {
		reads[0].resolve(null);
		await Bun.sleep(10);
	});
	await render(a, false);
	await render(a, true);
	expect(reads).toHaveLength(1);
	await act(async () => {
		invalidateGitPullRequest("/workspace", "main");
		await Bun.sleep(10);
	});
	expect(reads).toHaveLength(2);
	await render(a, false);
	expect(reads[1].signal.aborted).toBe(true);
	await render({ ...a, url: "https://b.test" }, true);
	expect(reads).toHaveLength(3);
	await render({ ...a, url: "https://b.test", token: "two" }, true);
	expect(reads).toHaveLength(4);
	expect(reads[2].signal.aborted).toBe(true);
	await render(
		{ ...a, url: "https://b.test", token: "two", userJwt: "next" },
		true
	);
	expect(reads).toHaveLength(5);
	expect(reads[3].signal.aborted).toBe(true);
});
