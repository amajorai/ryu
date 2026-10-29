import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const node = { token: "t", url: "https://node.test", userJwt: null };
mock.module("./useActiveNode.ts", () => ({ useActiveNode: () => node }));
const calls: Array<string | undefined> = [];
mock.module("@/src/lib/api/approvals.ts", () => ({
	approveApproval: () => Promise.resolve({}),
	listApprovals: (_target: unknown, status?: string) => {
		calls.push(status);
		return Promise.resolve([]);
	},
	rejectApproval: () => Promise.resolve({}),
}));
const { approvalsListKey, useApprovals } = await import("./useApprovals.ts");

const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const root = createRoot(document.createElement("div"));

function Pending() {
	useApprovals({ status: "pending" });
	return null;
}
function All() {
	useApprovals();
	return null;
}

afterAll(() => {
	act(() => root.unmount());
});

test("the status filter keys its own list and asks Core for that status", async () => {
	expect(approvalsListKey("u")).toEqual(["approvals", "list", "u"]);
	expect(approvalsListKey("u", "pending")).toEqual([
		"approvals",
		"list",
		"u",
		"pending",
	]);
	await act(async () => {
		root.render(
			createElement(
				QueryClientProvider,
				{ client },
				createElement(Pending),
				createElement(Pending)
			)
		);
		await Bun.sleep(10);
	});
	// Two pending callers share one query; the unfiltered list is never asked for.
	expect(calls).toEqual(["pending"]);
	await act(async () => {
		root.render(
			createElement(QueryClientProvider, { client }, createElement(All))
		);
		await Bun.sleep(10);
	});
	expect(calls).toEqual(["pending", undefined]);
});
