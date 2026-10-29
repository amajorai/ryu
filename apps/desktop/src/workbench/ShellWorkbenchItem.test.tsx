import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	createDefaultWorkbench,
	type WorkbenchItem,
} from "@ryu/workbench/model";
import { serializeWorkbenchSnapshot } from "@ryu/workbench/persistence";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

/* SAFETY: React act reads the documented IS_REACT_ACT_ENVIRONMENT boolean global in this DOM test environment; this statement publishes that single native flag. */ (
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let currentFolder: string | null = "/work/ryu";

// The real dock renderer mounts terminals and file trees; this stub records
// what it was asked to render so the test asserts only the scope decision.
mock.module("@/src/components/panels/WorkspacePanels.tsx", () => ({
	ConversationPanelContent: ({
		kind,
		source,
	}: {
		kind: string;
		source: { contextView: { conversationId: string } | null };
	}) => (
		<output data-conversation={source.contextView?.conversationId ?? ""}>
			{kind}
		</output>
	),
	ProjectDockTabContent: ({
		active,
		folder,
		request,
		tab,
	}: {
		active: boolean;
		folder: string | null;
		request?: { nonce: number; reviewPaths?: string[] };
		tab: { kind: string };
	}) => (
		<output
			data-active={String(active)}
			data-folder={folder ?? ""}
			data-review={request?.reviewPaths?.join(",") ?? ""}
		>
			{tab.kind}
		</output>
	),
}));
mock.module("@/src/hooks/usePluginContributions.ts", () => ({
	usePluginContributions: () => ({ dock_panels: [] }),
}));
mock.module("@/src/store/useWorkspaceStore.ts", () => ({
	useWorkspaceStore: (select: (state: { folder: string | null }) => unknown) =>
		select({ folder: currentFolder }),
}));

const { DesktopWorkbenchProvider } = await import(
	"./DesktopWorkbenchContext.tsx"
);
const { WORKBENCH_STORAGE_KEY } = await import(
	"./desktop-workbench-persistence.ts"
);
const { ShellWorkbenchItem } = await import("./ShellWorkbenchItem.tsx");
const { registerConversationPanelSource } = await import(
	"./conversation-panel-registry.ts"
);
const { getPanelCommand, queuePanelCommand } = await import(
	"./panel-commands.ts"
);

function toolItem(
	id: string,
	panel: string,
	scope: WorkbenchItem["scope"]
): WorkbenchItem {
	return {
		closable: true,
		duplicable: false,
		id,
		pinned: false,
		preferredRegion: "bottom",
		scope,
		source: { kind: "shell", panel },
		title: panel === "terminal" ? "Terminal" : "Context",
	};
}

describe("ShellWorkbenchItem", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		localStorage.clear();
		currentFolder = "/work/ryu";
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	async function render(item: WorkbenchItem) {
		const state = createDefaultWorkbench({
			bottomGroupId: "bottom-main",
			centerGroupId: "center-main",
			leftGroupId: "left-main",
			navigationId: "navigation",
			rightGroupId: "right-main",
		});
		state.items.push(item);
		state.openRegions.bottom = true;
		state.groups = state.groups.map((group) =>
			group.region === "bottom"
				? { ...group, activeItemId: item.id, itemIds: [item.id] }
				: group
		);
		localStorage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(serializeWorkbenchSnapshot(state))
		);
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					makeId={(prefix) => prefix}
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<ShellWorkbenchItem item={item} />
				</DesktopWorkbenchProvider>
			);
		});
	}

	test("renders a project tool for its own project through the dock renderer", async () => {
		await render(
			toolItem("t1", "terminal", { kind: "project", folder: "/work/ryu/" })
		);
		const output = container.querySelector("output");
		expect(output?.textContent).toBe("terminal");
		expect(output?.dataset.folder).toBe("/work/ryu/");
		expect(output?.dataset.active).toBe("true");
	});

	test("hands a queued request to the tab and forgets it when the tab closes", async () => {
		await render(
			toolItem("t1", "codereview", { kind: "project", folder: "/work/ryu" })
		);
		await act(async () => {
			queuePanelCommand("t1", { nonce: 1, reviewPaths: ["a.ts", "b.ts"] });
		});
		expect(container.querySelector("output")?.dataset.review).toBe("a.ts,b.ts");
		await act(async () => root.render(null));
		expect(getPanelCommand("t1")).toBeUndefined();
	});

	test("never renders a project tool under a different open project", async () => {
		currentFolder = "/work/other";
		await render(
			toolItem("t1", "terminal", { kind: "project", folder: "/work/ryu" })
		);
		expect(container.querySelector("output")).toBeNull();
		expect(container.textContent).toContain(
			"Terminal belongs to ryu. Open that project to use it."
		);
	});

	test("asks for the owning chat instead of showing another chat's data", async () => {
		await render(toolItem("c1", "context", { kind: "window" }));
		expect(container.querySelector("output")).toBeNull();
		expect(container.textContent).toContain(
			"Open Context from its chat to see it here."
		);
	});
	test("renders a chat panel from its own conversation's published source", async () => {
		const target = { token: "test", url: "http://127.0.0.1:1" };
		const unregister = registerConversationPanelSource("conv-a", {
			contextView: { conversationId: "conv-a", target },
			cowork: undefined,
		});
		const unregisterOther = registerConversationPanelSource("conv-b", {
			contextView: { conversationId: "conv-b", target },
			cowork: undefined,
		});
		try {
			await render(
				toolItem("c1", "context", {
					kind: "conversation",
					conversationId: "conv-a",
				})
			);
			const output = container.querySelector("output");
			expect(output?.textContent).toBe("context");
			expect(output?.dataset.conversation).toBe("conv-a");

			await act(async () => unregister());
			expect(container.querySelector("output")).toBeNull();
			expect(container.textContent).toContain("This chat is closed.");
		} finally {
			unregister();
			unregisterOther();
		}
	});
});
