import { beforeEach, describe, expect, test } from "bun:test";
import { useAssistantStore } from "./useAssistantStore.ts";

const summary = { id: "pull:acme/app#1", text: "summary", title: "#1" };
const diff = { id: "pull:acme/app#1:diff", text: "diff", title: "#1 diff" };

describe("assistant context removal", () => {
	beforeEach(() => {
		const store = useAssistantStore.getState();
		store.clearContextOwner("plugin:review");
		store.newConversation();
	});

	test("a removed chip stays out when its publisher re-publishes", () => {
		const store = useAssistantStore.getState();
		store.publishContext("plugin:review", [summary]);
		store.removePageContext(summary.id);
		// The diff finishes loading and the app republishes summary + diff.
		store.publishContext("plugin:review", [summary, diff]);
		expect(
			useAssistantStore.getState().pageContext.map((item) => item.id)
		).toEqual([diff.id]);
	});

	test("a page change or new chat offers removed context again", () => {
		const store = useAssistantStore.getState();
		store.publishContext("plugin:review", [summary]);
		store.removePageContext(summary.id);
		store.restoreContext();
		store.publishContext("plugin:review", [summary, diff]);
		expect(useAssistantStore.getState().pageContext).toHaveLength(2);

		store.removePageContext(diff.id);
		store.newConversation();
		store.publishContext("plugin:review", [summary, diff]);
		expect(useAssistantStore.getState().pageContext).toHaveLength(2);
	});
});

describe("answered permission requests", () => {
	beforeEach(() => {
		useAssistantStore.setState({ resolvedPermissions: {} });
	});

	test("outlive the panel and stay scoped to their conversation", () => {
		const store = useAssistantStore.getState();
		store.markPermissionResolved("thread-a", "req-1");
		store.markPermissionResolved("thread-a", "req-1");
		store.markPermissionResolved("thread-b", "req-2");
		const { resolvedPermissions } = useAssistantStore.getState();
		expect(resolvedPermissions["thread-a"]).toEqual(["req-1"]);
		expect(resolvedPermissions["thread-b"]).toEqual(["req-2"]);
	});

	test("stay bounded per session", () => {
		const store = useAssistantStore.getState();
		for (let index = 0; index < 40; index++) {
			store.markPermissionResolved(`scope-${index}`, "req");
		}
		const scopes = Object.keys(
			useAssistantStore.getState().resolvedPermissions
		);
		expect(scopes).toHaveLength(24);
		expect(scopes.at(-1)).toBe("scope-39");
	});
});
