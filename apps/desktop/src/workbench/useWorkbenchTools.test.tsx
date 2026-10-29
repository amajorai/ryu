import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

/* SAFETY: React act reads the documented IS_REACT_ACT_ENVIRONMENT boolean global in this DOM test environment; this statement publishes that single native flag. */ (
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("@/src/contexts/app-surface-context.tsx", () => ({
	useAppSurface: () => ({ canUseNativeShell: true }),
}));
mock.module("@/src/hooks/usePluginContributions.ts", () => ({
	usePluginContributions: () => ({ dock_panels: [] }),
}));
mock.module("@/src/store/useWorkspaceStore.ts", () => ({
	useWorkspaceStore: (select: (state: { folder: string | null }) => unknown) =>
		select({ folder: "/work/ryu" }),
}));

const { DesktopWorkbenchProvider, useDesktopWorkbench } = await import(
	"./DesktopWorkbenchContext.tsx"
);
const { WorkbenchToolsProvider, useWorkbenchDockBridgeValue } = await import(
	"./useWorkbenchTools.tsx"
);
const { useWorkbenchToolsContext } = await import("./workbench-chrome.tsx");
const { getPanelCommand } = await import("./panel-commands.ts");

type Workbench = ReturnType<typeof useDesktopWorkbench>;
type Tools = NonNullable<ReturnType<typeof useWorkbenchToolsContext>>;
type Bridge = NonNullable<ReturnType<typeof useWorkbenchDockBridgeValue>>;

const TERMINAL = {
	id: "terminal",
	label: "Terminal",
	region: "bottom",
} as const;
const FILES = { id: "files", label: "Files", region: "right" } as const;

describe("workbench openPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let workbench: Workbench | undefined;
	let tools: Tools | undefined;
	let bridge: Bridge | undefined;

	function Probe() {
		workbench = useDesktopWorkbench();
		tools = useWorkbenchToolsContext() ?? undefined;
		bridge = useWorkbenchDockBridgeValue() ?? undefined;
		return null;
	}

	function current() {
		if (!(workbench && tools && bridge)) {
			throw new Error("workbench not rendered");
		}
		return { bridge, tools, workbench };
	}

	function titlesIn(region: string): string[] {
		const { state } = current().workbench;
		const group = state.groups.find((candidate) => candidate.region === region);
		return (group?.itemIds ?? []).map(
			(id) => state.items.find((item) => item.id === id)?.title ?? id
		);
	}

	beforeEach(async () => {
		localStorage.clear();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<WorkbenchToolsProvider>
						<Probe />
					</WorkbenchToolsProvider>
				</DesktopWorkbenchProvider>
			);
		});
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	test("numbers new copies opened together in one handler", async () => {
		await act(async () => {
			current().tools.openPanel(TERMINAL, { forceNew: true });
			current().tools.openPanel(TERMINAL, { forceNew: true });
		});
		expect(titlesIn("bottom")).toEqual(["Terminal", "Terminal 2"]);
		expect(current().workbench.state.openRegions.bottom).toBe(true);
	});

	test("focuses the open tab for the same panel instead of stacking", async () => {
		let first: string | undefined;
		let second: string | undefined;
		await act(async () => {
			first = current().tools.openPanel(FILES);
		});
		await act(async () => {
			second = current().tools.openPanel(FILES, {
				nonce: 7,
				reviewPaths: ["src/a.ts"],
			});
		});
		expect(second).toBe(first);
		expect(titlesIn("right")).toEqual(["Files"]);
		expect(getPanelCommand(first ?? "")).toEqual({
			command: undefined,
			nonce: 7,
			reviewPaths: ["src/a.ts"],
		});
	});

	test("opens in the background without focusing or revealing", async () => {
		const focused = current().workbench.state.focusedGroupId;
		await act(async () => {
			current().tools.openPanel(FILES, { activate: false });
		});
		expect(titlesIn("right")).toEqual(["Files"]);
		expect(current().workbench.state.openRegions.right).toBe(false);
		expect(current().workbench.state.focusedGroupId).toBe(focused);
	});

	test("reveals a tab while keeping focus with the pane that asked", async () => {
		const focused = current().workbench.state.focusedGroupId;
		await act(async () => {
			current().tools.openPanel(FILES, { preserveFocus: true });
		});
		expect(titlesIn("right")).toEqual(["Files"]);
		expect(current().workbench.state.openRegions.right).toBe(true);
		expect(current().workbench.state.focusedGroupId).toBe(focused);
	});

	test("the bridge toggles a region and seeds an empty one", async () => {
		expect(current().bridge.isRegionShown("bottom")).toBe(false);
		await act(async () => current().bridge.toggleRegion("bottom"));
		expect(titlesIn("bottom")).toEqual(["Terminal"]);
		expect(current().bridge.isRegionShown("bottom")).toBe(true);
		await act(async () => current().bridge.toggleRegion("bottom"));
		expect(current().bridge.isRegionShown("bottom")).toBe(false);
		await act(async () => current().bridge.toggleRegion("bottom"));
		expect(titlesIn("bottom")).toEqual(["Terminal"]);
		expect(current().bridge.isRegionShown("bottom")).toBe(true);
	});
});
