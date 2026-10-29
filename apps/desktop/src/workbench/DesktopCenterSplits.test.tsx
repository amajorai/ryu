import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createDefaultWorkbench } from "@ryu/workbench/model";
import { serializeWorkbenchSnapshot } from "@ryu/workbench/persistence";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { z } from "zod";
import { applyWorkbenchPaneDrop } from "@/src/components/layout/SplitDropZones.tsx";
import { makePresetBranch, makeSlot } from "@/src/lib/splitPresets.ts";
import {
	DesktopWorkbenchProvider,
	type DesktopWorkbenchValue,
	useDesktopWorkbench,
} from "./DesktopWorkbenchContext.tsx";
import { WORKBENCH_STORAGE_KEY } from "./desktop-workbench-persistence.ts";

mock.module("@/src/contexts/entitlement-context.tsx", () => ({
	useEntitlementContext: () => ({
		canUse: () => true,
		ready: true,
		refresh: async () => undefined,
		requestUpgrade: () => undefined,
		verdict: null,
	}),
}));

const {
	TabsProvider,
	openTabFromEmptyCenter,
	shouldAutoUnloadWorkbenchTab,
	useTabsContext,
	workbenchActiveItemsProtectedFromUnload,
} = await import("@/src/contexts/TabsContext.tsx");
type TabsValue = ReturnType<typeof useTabsContext>;

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

// SAFETY: The actual installed ReactDOM act environment reads this optional
// global flag. This test writes the authored boolean true to that native hook;
// the declaration gap concerns only this flag, without asserting other globals
// or replacing the registered DOM/native React test environment.
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function routeIdsInCenter(workbench: DesktopWorkbenchValue): string[] {
	const routeIds = new Set(
		workbench.state.items.flatMap((item) =>
			item.source.kind === "route" ? [item.id] : []
		)
	);
	return workbench.state.groups
		.filter((group) => group.region === "center")
		.flatMap((group) => group.itemIds)
		.filter((itemId) => routeIds.has(itemId));
}

describe("Desktop Center split compatibility", () => {
	let container: HTMLDivElement;
	let root: Root;
	let tabs: TabsValue | undefined;
	let workbench: DesktopWorkbenchValue | undefined;

	function Probe() {
		tabs = useTabsContext();
		workbench = useDesktopWorkbench();
		return null;
	}

	async function renderProviders() {
		await act(async () => {
			root.render(
				<DesktopWorkbenchProvider
					makeId={(prefix) => prefix}
					persistenceDelayMs={60_000}
					storage={localStorage}
				>
					<TabsProvider>
						<Probe />
					</TabsProvider>
				</DesktopWorkbenchProvider>
			);
		});
	}

	function currentTabs(): TabsValue {
		if (!tabs) {
			throw new Error("Tabs probe did not mount");
		}
		return tabs;
	}

	function currentWorkbench(): DesktopWorkbenchValue {
		if (!workbench) {
			throw new Error("Workbench probe did not mount");
		}
		return workbench;
	}

	async function openThreePaneSplit(): Promise<[string, string, string]> {
		const ids: string[] = [];
		for (const path of ["/settings", "/downloads", "/calendar"]) {
			await act(async () => ids.push(currentTabs().openTab(path)));
		}
		await act(async () => currentTabs().splitTabs(ids));
		return [ids[0], ids[1], ids[2]];
	}

	function detachedPaneSnapshot(detachedId: string) {
		const current = currentWorkbench();
		const destination = current.state.groups.find((group) =>
			group.itemIds.includes(detachedId)
		);
		return {
			destinationActiveId: destination?.activeItemId,
			destinationItemIds: destination?.itemIds,
			detachedSplitId: currentTabs().tabs.find((tab) => tab.id === detachedId)
				?.splitId,
			splitMemberIds: currentTabs()
				.tabs.filter((tab) => tab.splitId)
				.map((tab) => tab.id),
		};
	}

	beforeEach(() => {
		localStorage.clear();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		tabs = undefined;
		workbench = undefined;
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	test("projects route tabs from workbench items and splits the shared Center tree", async () => {
		await renderProviders();

		let firstId = "";
		let secondId = "";
		let thirdId = "";
		await act(async () => {
			firstId = tabs?.openTab("/settings", { title: "Settings" }) ?? "";
		});
		await act(async () => {
			secondId = tabs?.openTab("/downloads", { title: "Downloads" }) ?? "";
		});
		await act(async () => {
			thirdId = tabs?.openTab("/calendar", { title: "Calendar" }) ?? "";
		});
		await act(async () => {
			tabs?.splitTabs([firstId, secondId], "columns");
		});

		if (!workbench) {
			throw new Error("Workbench probe did not mount");
		}
		const primaryGroup = workbench.state.groups.find((group) =>
			group.itemIds.includes(firstId)
		);
		const secondaryGroup = workbench.state.groups.find((group) =>
			group.itemIds.includes(secondId)
		);
		if (!(primaryGroup && secondaryGroup)) {
			throw new Error("Split groups were not created");
		}
		expect(primaryGroup?.region).toBe("center");
		expect(secondaryGroup?.region).toBe("center");
		expect(secondaryGroup?.id).not.toBe(primaryGroup?.id);
		expect(workbench.state.centerTree).toEqual({
			type: "branch",
			orientation: "columns",
			sizes: [0.5, 0.5],
			children: [
				{ type: "leaf", groupId: primaryGroup.id },
				{ type: "leaf", groupId: secondaryGroup.id },
			],
		});
		expect(routeIdsInCenter(workbench)).toEqual(
			expect.arrayContaining([firstId, secondId, thirdId])
		);
		expect(tabs?.tabs.map((tab) => tab.id)).toEqual(
			expect.arrayContaining([firstId, secondId, thirdId])
		);
	});

	test("derives addTabToSplit membership and geometry from the shared Center tree", async () => {
		await renderProviders();
		const ids: string[] = [];
		for (const path of ["/settings", "/downloads", "/calendar"]) {
			await act(async () => {
				ids.push(tabs?.openTab(path) ?? "");
			});
		}
		await act(async () => tabs?.splitTabs(ids.slice(0, 2), "columns"));
		const splitId = tabs?.splits[0]?.id;
		if (!splitId) {
			throw new Error("Projected split did not exist");
		}
		await act(async () => tabs?.addTabToSplit(splitId, ids[2]));

		expect(workbench?.state.centerTree).toMatchObject({
			type: "branch",
			orientation: "columns",
			sizes: [1 / 3, 1 / 3, 1 / 3],
		});
		expect(tabs?.splits).toHaveLength(1);
		expect(tabs?.splits[0]?.id).toBe(splitId);
		expect(tabs?.splits[0]?.root).toMatchObject({
			type: "branch",
			sizes: [1 / 3, 1 / 3, 1 / 3],
		});
		expect(
			tabs?.tabs.filter((tab) => tab.splitId === splitId).map((tab) => tab.id)
		).toEqual(expect.arrayContaining(ids));
	});

	test("detaches a pinned pane as background without displacing a surviving pane", async () => {
		await renderProviders();
		const [firstId, secondId, thirdId] = await openThreePaneSplit();
		await act(async () => currentTabs().togglePin(thirdId));

		const snapshot = detachedPaneSnapshot(thirdId);
		expect(snapshot.destinationActiveId).toBe(firstId);
		expect(snapshot.destinationItemIds).toContain(thirdId);
		expect(snapshot.detachedSplitId).toBeUndefined();
		expect(snapshot.splitMemberIds).toEqual(
			expect.arrayContaining([firstId, secondId])
		);
		expect(snapshot.splitMemberIds).toHaveLength(2);
		expect(currentTabs().tabs.find((tab) => tab.id === thirdId)?.pinned).toBe(
			true
		);
	});

	test("detaches a grouped pane as background without displacing a surviving pane", async () => {
		await renderProviders();
		const [firstId, secondId, thirdId] = await openThreePaneSplit();
		let presentationGroupId = "";
		await act(async () => {
			presentationGroupId = currentTabs().createGroup(thirdId);
		});

		const snapshot = detachedPaneSnapshot(thirdId);
		expect(snapshot.destinationActiveId).toBe(firstId);
		expect(snapshot.destinationItemIds).toContain(thirdId);
		expect(snapshot.detachedSplitId).toBeUndefined();
		expect(snapshot.splitMemberIds).toEqual(
			expect.arrayContaining([firstId, secondId])
		);
		expect(snapshot.splitMemberIds).toHaveLength(2);
		expect(currentTabs().tabs.find((tab) => tab.id === thirdId)?.groupId).toBe(
			presentationGroupId
		);
	});

	test("removeFromSplit keeps the detached route behind the destination active pane", async () => {
		await renderProviders();
		const [firstId, secondId, thirdId] = await openThreePaneSplit();
		await act(async () => currentTabs().removeFromSplit(thirdId));

		const snapshot = detachedPaneSnapshot(thirdId);
		expect(snapshot.destinationActiveId).toBe(firstId);
		expect(snapshot.destinationItemIds).toContain(thirdId);
		expect(snapshot.detachedSplitId).toBeUndefined();
		expect(snapshot.splitMemberIds).toEqual(
			expect.arrayContaining([firstId, secondId])
		);
		expect(snapshot.splitMemberIds).toHaveLength(2);
	});

	test("projects an edge DnD split into a visible shared pane", async () => {
		await renderProviders();
		let firstId = "";
		let secondId = "";
		await act(async () => {
			firstId = tabs?.openTab("/settings") ?? "";
		});
		await act(async () => {
			secondId = tabs?.openTab("/downloads") ?? "";
		});
		let presentationGroupId = "";
		await act(async () => {
			presentationGroupId = currentTabs().createGroup(secondId);
			currentWorkbench().dispatch({
				type: "item/pin",
				itemId: secondId,
				pinned: true,
			});
		});
		await act(async () => workbench?.moveItem(secondId, { region: "right" }));
		const targetGroupId = workbench?.state.groups.find((group) =>
			group.itemIds.includes(firstId)
		)?.id;
		if (!targetGroupId) {
			throw new Error("DnD fixture did not create its target group");
		}
		const dndWorkbench = currentWorkbench();
		const synchronizeRoute = currentTabs().prepareTabForWorkbenchSplit;
		await act(async () => {
			applyWorkbenchPaneDrop({
				dispatch: dndWorkbench.dispatch,
				draggingId: secondId,
				makeGroupId: () => "center-drop",
				state: dndWorkbench.state,
				synchronizeRoute,
				targetGroupId,
				zone: "right",
			});
		});

		const droppedWorkbench = currentWorkbench();
		expect(
			droppedWorkbench.state.groups.find((group) => group.id === "center-drop")
				?.itemIds
		).toEqual([secondId]);
		expect(tabs?.splits[0]?.root).toEqual({
			type: "branch",
			children: [
				{ type: "leaf", tabId: firstId },
				{ type: "leaf", tabId: secondId },
			],
			orientation: "columns",
			sizes: [0.5, 0.5],
		});
		const runtimeTab = currentTabs().tabs.find((tab) => tab.id === secondId);
		expect(runtimeTab).toMatchObject({ groupId: undefined, pinned: false });
		expect(presentationGroupId).not.toBe("");
		expect(
			currentWorkbench().state.groups.filter((group) =>
				group.itemIds.includes(secondId)
			)
		).toHaveLength(1);
		window.dispatchEvent(new Event("pagehide"));
		const persisted = z
			.object({
				tabs: z
					.array(
						z.object({
							id: z.string().optional(),
							pinned: z.boolean().optional(),
						})
					)
					.optional(),
			})
			.parse(JSON.parse(localStorage.getItem("ryu_session_tabs") ?? "{}"));
		expect(persisted.tabs?.find((tab) => tab.id === secondId)?.pinned).toBe(
			false
		);
	});

	test("center drop rejects unknown and non-Center targets before runtime synchronization", async () => {
		await renderProviders();
		let itemId = "";
		await act(async () => {
			itemId = currentTabs().openTab("/settings");
		});
		const beforeWorkbench = JSON.stringify(currentWorkbench().state);
		const beforeRuntime = currentTabs().tabs.find((tab) => tab.id === itemId);
		let synchronized = 0;
		const state = currentWorkbench().state;
		const rightGroupId = state.groups.find(
			(group) => group.region === "right"
		)?.id;
		if (!rightGroupId) {
			throw new Error("Right group fixture is missing");
		}
		await act(async () => {
			for (const targetGroupId of ["missing-center", rightGroupId]) {
				applyWorkbenchPaneDrop({
					dispatch: currentWorkbench().dispatch,
					draggingId: itemId,
					state,
					synchronizeRoute: () => {
						synchronized += 1;
					},
					targetGroupId,
					zone: "center",
				});
			}
		});

		expect(synchronized).toBe(0);
		expect(JSON.stringify(currentWorkbench().state)).toBe(beforeWorkbench);
		expect(currentTabs().tabs.find((tab) => tab.id === itemId)).toEqual(
			beforeRuntime
		);
	});

	test("center drop moves into a valid empty Center group and synchronizes once", async () => {
		await renderProviders();
		let itemId = "";
		let presentationGroupId = "";
		await act(async () => {
			itemId = currentTabs().openTab("/settings");
			presentationGroupId = currentTabs().createGroup(itemId);
		});
		const sourceGroupId = currentWorkbench().state.groups.find((group) =>
			group.itemIds.includes(itemId)
		)?.id;
		if (!sourceGroupId) {
			throw new Error("Source Center group is missing");
		}
		await act(async () =>
			currentWorkbench().dispatch({
				type: "center/split",
				direction: "right",
				newGroupId: "empty-center",
				targetGroupId: sourceGroupId,
			})
		);
		let synchronized = 0;
		const state = currentWorkbench().state;
		await act(async () => {
			applyWorkbenchPaneDrop({
				dispatch: currentWorkbench().dispatch,
				draggingId: itemId,
				state,
				synchronizeRoute: (routeId) => {
					synchronized += 1;
					currentTabs().prepareTabForWorkbenchSplit(routeId);
				},
				targetGroupId: "empty-center",
				zone: "center",
			});
		});

		const current = currentWorkbench();
		const target = current.state.groups.find(
			(group) => group.id === "empty-center"
		);
		expect(synchronized).toBe(1);
		expect(target).toMatchObject({
			activeItemId: itemId,
			itemIds: [itemId],
		});
		expect(current.state.focusedGroupId).toBe("empty-center");
		expect(
			current.state.groups.filter((group) => group.itemIds.includes(itemId))
		).toHaveLength(1);
		expect(currentTabs().tabs.find((tab) => tab.id === itemId)).toMatchObject({
			groupId: undefined,
			pinned: false,
		});
		expect(presentationGroupId).not.toBe("");
	});

	test("center drop still swaps two nonempty Center groups", async () => {
		await renderProviders();
		let firstId = "";
		let secondId = "";
		await act(async () => {
			firstId = currentTabs().openTab("/settings");
		});
		await act(async () => {
			secondId = currentTabs().openTab("/downloads");
		});
		await act(async () => currentTabs().splitTabs([firstId, secondId]));
		const before = currentWorkbench().state;
		const sourceGroupId = before.groups.find((group) =>
			group.itemIds.includes(firstId)
		)?.id;
		const targetGroupId = before.groups.find((group) =>
			group.itemIds.includes(secondId)
		)?.id;
		if (!(sourceGroupId && targetGroupId)) {
			throw new Error("Swap groups are missing");
		}
		const synchronized: string[] = [];
		await act(async () => {
			applyWorkbenchPaneDrop({
				dispatch: currentWorkbench().dispatch,
				draggingId: firstId,
				state: before,
				synchronizeRoute: (routeId) => synchronized.push(routeId),
				targetGroupId,
				zone: "center",
			});
		});

		expect(synchronized).toEqual([firstId]);
		expect(
			currentWorkbench().state.groups.find(
				(group) => group.id === sourceGroupId
			)?.itemIds
		).toEqual([secondId]);
		expect(
			currentWorkbench().state.groups.find(
				(group) => group.id === targetGroupId
			)?.itemIds
		).toEqual([firstId]);
		expect(
			currentWorkbench().state.groups.filter((group) =>
				group.itemIds.includes(firstId)
			)
		).toHaveLength(1);
	});

	test("creates a flat equal three-pane tree and moves side-region sources into Center", async () => {
		await renderProviders();
		const ids: string[] = [];
		for (const path of ["/settings", "/downloads", "/calendar"]) {
			await act(async () => {
				ids.push(tabs?.openTab(path) ?? "");
			});
		}
		await act(async () => {
			workbench?.moveItem(ids[2], { region: "right" });
		});
		expect(
			workbench?.state.groups.find((group) => group.region === "right")?.itemIds
		).toContain(ids[2]);
		await act(async () => tabs?.splitTabs(ids, "columns"));

		const tree = workbench?.state.centerTree;
		expect(tree).toMatchObject({
			type: "branch",
			orientation: "columns",
			sizes: [1 / 3, 1 / 3, 1 / 3],
		});
		if (tree?.type !== "branch") {
			throw new Error("Flat Center tree was not installed");
		}
		expect(tree.children.every((child) => child.type === "leaf")).toBe(true);
		if (!workbench) {
			throw new Error("Workbench missing");
		}
		expect(routeIdsInCenter(workbench)).toEqual(expect.arrayContaining(ids));
	});

	test("changes only the shared root orientation while preserving nested geometry and memberships", async () => {
		await renderProviders();
		const ids: string[] = [];
		for (const path of ["/settings", "/downloads", "/calendar", "/review"]) {
			await act(async () => ids.push(tabs?.openTab(path) ?? ""));
		}
		const preset = makePresetBranch(
			"columns",
			[
				makeSlot(),
				makePresetBranch("rows", [makeSlot(), makeSlot()], [0.4, 0.6]),
			],
			[0.6, 0.4]
		);
		await act(async () => tabs?.applySplitPreset(preset, ids.slice(0, 3)));
		const beforeTree = currentWorkbench().state.centerTree;
		const beforeGroups = workbench?.state.groups.map((group) => ({
			id: group.id,
			itemIds: group.itemIds,
		}));
		const splitId = tabs?.splits[0]?.id;
		if (!splitId || beforeTree.type !== "branch") {
			throw new Error("Projected nested split did not exist");
		}
		await act(async () => tabs?.setSplitOrientation(splitId, "rows"));

		expect(workbench?.state.centerTree).toEqual({
			...beforeTree,
			orientation: "rows",
		});
		expect(
			workbench?.state.groups.map((group) => ({
				id: group.id,
				itemIds: group.itemIds,
			}))
		).toEqual(beforeGroups);
		expect(routeIdsInCenter(currentWorkbench())).toContain(ids[3]);
	});

	test("computes same-group reorder indexes after removing the dragged item", async () => {
		await renderProviders();
		const ids: string[] = [];
		for (const path of ["/settings", "/downloads", "/calendar"]) {
			await act(async () => ids.push(tabs?.openTab(path) ?? ""));
		}
		const groupId = workbench?.state.groups.find((group) =>
			group.itemIds.includes(ids[0])
		)?.id;
		const order = () =>
			workbench?.state.groups.find((group) => group.id === groupId)?.itemIds;

		await act(async () => tabs?.moveTab(ids[0], ids[1], true));
		expect(order()).toEqual(ids);
		await act(async () => tabs?.moveTab(ids[0], ids[1], false));
		expect(order()).toEqual([ids[1], ids[0], ids[2]]);
		await act(async () => tabs?.moveTab(ids[2], ids[1], true));
		expect(order()).toEqual([ids[2], ids[1], ids[0]]);
	});

	test("maps pane edits, pinning, close, and restore onto shared workbench state", async () => {
		await renderProviders();
		let firstId = "";
		let secondId = "";
		let thirdId = "";
		await act(async () => {
			firstId = tabs?.openTab("/settings") ?? "";
		});
		await act(async () => {
			secondId = tabs?.openTab("/downloads") ?? "";
		});
		await act(async () => {
			thirdId = tabs?.openTab("/calendar") ?? "";
		});
		await act(async () => tabs?.splitTabs([firstId, secondId], "columns"));
		const splitId = tabs?.splits[0]?.id;
		expect(splitId).toBeDefined();
		if (!splitId) {
			throw new Error("Compatibility split was not created");
		}

		await act(async () => tabs?.setSplitSizes(splitId, [], [0.3, 0.7]));
		expect(workbench?.state.centerTree).toMatchObject({ sizes: [0.3, 0.7] });
		await act(async () => tabs?.equalizeSplit(splitId));
		expect(workbench?.state.centerTree).toMatchObject({ sizes: [0.5, 0.5] });

		const firstGroupId = workbench?.state.groups.find((group) =>
			group.itemIds.includes(firstId)
		)?.id;
		const secondGroupId = workbench?.state.groups.find((group) =>
			group.itemIds.includes(secondId)
		)?.id;
		await act(async () => tabs?.swapSplitPanes(firstId, secondId));
		expect(
			workbench?.state.groups.find((group) => group.id === firstGroupId)
				?.itemIds
		).toContain(secondId);
		expect(
			workbench?.state.groups.find((group) => group.id === secondGroupId)
				?.itemIds
		).toContain(firstId);

		await act(async () => tabs?.replacePaneTab(secondId, thirdId));
		expect(workbench?.state.items.some((item) => item.id === secondId)).toBe(
			false
		);
		expect(workbench?.state.items.some((item) => item.id === thirdId)).toBe(
			true
		);
		await act(async () => tabs?.removeFromSplit(firstId));
		expect(workbench?.state.centerTree.type).toBe("leaf");

		await act(async () => tabs?.togglePin(firstId));
		expect(
			workbench?.state.items.find((item) => item.id === firstId)?.pinned
		).toBe(true);
		await act(async () => tabs?.closeTab(firstId));
		expect(workbench?.state.items.some((item) => item.id === firstId)).toBe(
			false
		);
		await act(async () => tabs?.restoreTab());
		expect(workbench?.state.items.some((item) => item.id === firstId)).toBe(
			true
		);
		expect(tabs?.activeTabId).toBe(firstId);
	});

	test("restores a locally closed split member into its shared Center group and projection", async () => {
		await renderProviders();
		let firstId = "";
		let secondId = "";
		await act(async () => {
			firstId = tabs?.openTab("/settings") ?? "";
		});
		await act(async () => {
			secondId = tabs?.openTab("/downloads") ?? "";
		});
		await act(async () => tabs?.splitTabs([firstId, secondId]));
		const splitId = tabs?.splits[0]?.id;
		const secondGroupId = workbench?.state.groups.find((group) =>
			group.itemIds.includes(secondId)
		)?.id;
		await act(async () => tabs?.closeTab(secondId));
		expect(tabs?.splits).toHaveLength(0);
		expect(
			workbench?.state.groups.find((group) => group.id === secondGroupId)
				?.itemIds
		).toEqual([]);
		await act(async () => tabs?.restoreTab());

		expect(
			workbench?.state.groups.find((group) => group.id === secondGroupId)
				?.itemIds
		).toContain(secondId);
		expect(tabs?.splits[0]?.id).toBe(splitId);
		expect(tabs?.tabs.find((tab) => tab.id === secondId)?.splitId).toBe(
			splitId
		);
	});

	test("closing an active side route preserves its side-group fallback instead of jumping Center", async () => {
		await renderProviders();
		let centerFirst = "";
		let centerSecond = "";
		let rightFirst = "";
		let rightSecond = "";
		await act(async () => {
			centerFirst = currentTabs().openTab("/settings");
		});
		await act(async () => {
			centerSecond = currentTabs().openTab("/downloads");
		});
		await act(async () => currentTabs().splitTabs([centerFirst, centerSecond]));
		await act(async () =>
			currentWorkbench().dispatch({ type: "region/show", region: "right" })
		);
		await act(async () => {
			rightFirst = currentTabs().openTab("/calendar");
		});
		await act(async () =>
			currentWorkbench().moveItem(rightFirst, { region: "right" })
		);
		await act(async () => {
			rightSecond = currentTabs().openTab("/review");
		});
		await act(async () =>
			currentWorkbench().moveItem(rightSecond, { region: "right" })
		);
		await act(async () =>
			currentWorkbench().dispatch({
				type: "item/activate",
				itemId: rightSecond,
			})
		);
		expect(currentTabs().activeTabId).toBe(rightSecond);
		await act(async () => currentTabs().closeTab(rightSecond));

		const rightGroup = currentWorkbench().state.groups.find(
			(group) => group.region === "right"
		);
		if (!rightGroup) {
			throw new Error("Right group disappeared after closing its active route");
		}
		expect(rightGroup.activeItemId).toBe(rightFirst);
		expect(currentWorkbench().state.focusedGroupId).toBe(rightGroup.id);
		expect(currentTabs().activeTabId).toBe(rightFirst);
		expect(currentTabs().splits[0]?.root).toMatchObject({ type: "branch" });
	});

	test("keeps singleton and conversation chat identity aligned with item ids", async () => {
		await renderProviders();
		let firstSettings = "";
		let secondSettings = "";
		let firstChat = "";
		let secondChat = "";
		let reboundChat = "";
		await act(async () => {
			firstSettings = tabs?.openTab("/settings") ?? "";
		});
		await act(async () => {
			secondSettings = tabs?.openTab("/settings") ?? "";
		});
		await act(async () => {
			firstChat = tabs?.openTab("/chat") ?? "";
		});
		await act(async () => {
			secondChat = tabs?.openTab("/chat") ?? "";
		});
		await act(async () =>
			tabs?.bindTabConversation(firstChat, "conversation-1")
		);
		await act(async () => {
			reboundChat =
				tabs?.openTab("/chat", { conversationId: "conversation-1" }) ?? "";
		});

		expect(secondSettings).toBe(firstSettings);
		expect(secondChat).not.toBe(firstChat);
		expect(reboundChat).toBe(firstChat);
		expect(
			workbench?.state.items.filter((item) => item.source.kind === "route")
				.length
		).toBe(3);
	});

	test("updates the authoritative Workbench route source and title in place", async () => {
		await renderProviders();
		let itemId = "";
		await act(async () => {
			itemId = tabs?.openTab("/settings") ?? "";
		});
		await act(async () => {
			tabs?.setTabRoute(itemId, "/downloads", { title: "My downloads" });
		});

		expect(
			workbench?.state.items.find((item) => item.id === itemId)
		).toMatchObject({
			title: "My downloads",
			source: { kind: "route", path: "/downloads" },
		});
		expect(tabs?.tabs.find((tab) => tab.id === itemId)).toMatchObject({
			path: "/downloads",
			title: "My downloads",
		});
	});

	test("hydrates runtime conversation metadata onto persisted workbench item ids", async () => {
		const persisted = createDefaultWorkbench({
			bottomGroupId: "workbench-bottom",
			centerGroupId: "workbench-center",
			leftGroupId: "workbench-left",
			navigationId: "workbench-navigation",
			rightGroupId: "workbench-right",
		});
		persisted.items.push({
			closable: true,
			duplicable: true,
			id: "stable-chat-item",
			pinned: false,
			preferredRegion: "center",
			scope: { kind: "conversation", conversationId: "conversation-persisted" },
			source: { kind: "route", path: "/chat" },
			title: "Persisted chat",
		});
		persisted.groups = persisted.groups.map((group) =>
			group.id === "workbench-center"
				? {
						...group,
						activeItemId: "stable-chat-item",
						itemIds: ["stable-chat-item"],
					}
				: group
		);
		localStorage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(serializeWorkbenchSnapshot(persisted))
		);
		localStorage.setItem("ryu_startup_behavior", "restore");
		localStorage.setItem(
			"ryu_session_tabs",
			JSON.stringify({
				activeIndex: 0,
				tabs: [
					{
						conversationId: "conversation-persisted",
						path: "/chat",
						title: "Runtime title",
					},
				],
			})
		);
		await renderProviders();

		expect(tabs?.tabs).toHaveLength(1);
		expect(tabs?.tabs[0]).toMatchObject({
			conversationId: "conversation-persisted",
			id: "stable-chat-item",
			path: "/chat",
			title: "Persisted chat",
		});
		expect(tabs?.activeTabId).toBe("stable-chat-item");
	});

	test("preserves multiple same-path chat bindings by stable id across a reordered restart", async () => {
		await renderProviders();
		let firstId = "";
		let secondId = "";
		await act(async () => {
			firstId =
				tabs?.openTab("/chat", {
					conversationId: "conversation-a",
					title: "Chat A",
				}) ?? "";
		});
		await act(async () => {
			secondId =
				tabs?.openTab("/chat", {
					conversationId: "conversation-b",
					forceNew: true,
					title: "Chat B",
				}) ?? "";
		});
		await act(async () => tabs?.splitTabs([firstId, secondId]));
		await act(async () => tabs?.swapSplitPanes(firstId, secondId));
		await act(async () => root.unmount());
		localStorage.setItem("ryu_startup_behavior", "restore");
		root = createRoot(container);
		tabs = undefined;
		workbench = undefined;
		await renderProviders();
		const restoredTabs = currentTabs();
		const restoredWorkbench = currentWorkbench();

		expect(
			restoredTabs.tabs.find((tab) => tab.id === firstId)?.conversationId
		).toBe("conversation-a");
		expect(
			restoredTabs.tabs.find((tab) => tab.id === secondId)?.conversationId
		).toBe("conversation-b");
		expect(
			restoredWorkbench.state.items.find((item) => item.id === firstId)?.scope
		).toEqual({ kind: "conversation", conversationId: "conversation-a" });
		expect(
			restoredWorkbench.state.items.find((item) => item.id === secondId)?.scope
		).toEqual({ kind: "conversation", conversationId: "conversation-b" });
	});

	test("does not consume an unrelated old session row as fallback metadata", async () => {
		const persisted = createDefaultWorkbench({
			bottomGroupId: "workbench-bottom",
			centerGroupId: "workbench-center",
			leftGroupId: "workbench-left",
			navigationId: "workbench-navigation",
			rightGroupId: "workbench-right",
		});
		persisted.items.push({
			closable: true,
			duplicable: true,
			id: "stable-settings",
			pinned: false,
			preferredRegion: "center",
			scope: { kind: "window" },
			source: { kind: "route", path: "/settings" },
			title: "Settings",
		});
		persisted.groups = persisted.groups.map((group) =>
			group.id === "workbench-center"
				? {
						...group,
						activeItemId: "stable-settings",
						itemIds: ["stable-settings"],
					}
				: group
		);
		localStorage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(serializeWorkbenchSnapshot(persisted))
		);
		localStorage.setItem("ryu_startup_behavior", "restore");
		localStorage.setItem(
			"ryu_session_tabs",
			JSON.stringify({
				activeIndex: 0,
				tabs: [{ path: "/downloads", title: "Downloads metadata" }],
			})
		);
		await renderProviders();

		expect(
			tabs?.tabs.find((tab) => tab.id === "stable-settings")
		).toMatchObject({
			path: "/settings",
			title: "Settings",
		});
		expect(tabs?.tabs.some((tab) => tab.path === "/downloads")).toBe(true);
	});

	test("protects active items in visible groups while leaving hidden and background items eligible", () => {
		const state = createDefaultWorkbench({
			bottomGroupId: "bottom",
			centerGroupId: "center-a",
			leftGroupId: "left",
			navigationId: "navigation",
			rightGroupId: "right",
		});
		state.groups.push({
			activeItemId: "center-secondary",
			id: "center-b",
			itemIds: ["center-secondary"],
			locked: false,
			region: "center",
		});
		state.centerTree = {
			type: "branch",
			children: [
				{ type: "leaf", groupId: "center-a" },
				{ type: "leaf", groupId: "center-b" },
			],
			orientation: "columns",
			sizes: [0.5, 0.5],
		};
		state.groups = state.groups.map((group) => {
			if (group.id === "center-a") {
				return {
					...group,
					activeItemId: "center-primary",
					itemIds: ["center-primary", "center-background"],
				};
			}
			if (group.id === "right") {
				return {
					...group,
					activeItemId: "right-active",
					itemIds: ["right-active"],
				};
			}
			if (group.id === "bottom") {
				return {
					...group,
					activeItemId: "bottom-hidden",
					itemIds: ["bottom-hidden"],
				};
			}
			return group;
		});
		state.openRegions.right = true;
		state.openRegions.bottom = false;

		const protectedIds = workbenchActiveItemsProtectedFromUnload(state);
		expect(protectedIds).toEqual(
			new Set([
				"navigation",
				"center-primary",
				"center-secondary",
				"right-active",
			])
		);
		expect(protectedIds.has("center-background")).toBe(false);
		expect(protectedIds.has("bottom-hidden")).toBe(false);
		expect(
			shouldAutoUnloadWorkbenchTab({
				cutoff: 100,
				lastActive: 1,
				state,
				tab: { id: "right-active", path: "/review", title: "Right" },
			})
		).toBe(false);
		expect(
			shouldAutoUnloadWorkbenchTab({
				cutoff: 100,
				lastActive: 1,
				state,
				tab: { id: "bottom-hidden", path: "/review", title: "Bottom" },
			})
		).toBe(true);
		expect(
			shouldAutoUnloadWorkbenchTab({
				cutoff: 100,
				lastActive: 1,
				state,
				tab: {
					id: "center-background",
					path: "/review",
					title: "Background",
				},
			})
		).toBe(true);
	});

	test("explicit unload follows visible Workbench ownership instead of stale global activity", async () => {
		await renderProviders();
		let centerId = "";
		let hiddenSideId = "";
		await act(async () => {
			centerId = currentTabs().openTab("/settings");
		});
		await act(async () => currentTabs().unloadTab(centerId));
		expect(
			currentTabs().tabs.find((tab) => tab.id === centerId)?.unloaded
		).not.toBe(true);

		await act(async () => {
			hiddenSideId = currentTabs().openTab("/review");
		});
		await act(async () =>
			currentWorkbench().dispatch({ type: "region/show", region: "right" })
		);
		await act(async () =>
			currentWorkbench().moveItem(hiddenSideId, { region: "right" })
		);
		expect(currentTabs().activeTabId).toBe(hiddenSideId);
		await act(async () =>
			currentWorkbench().dispatch({ type: "region/hide", region: "right" })
		);
		await act(async () => currentTabs().unloadTab(hiddenSideId));
		expect(
			currentTabs().tabs.find((tab) => tab.id === hiddenSideId)?.unloaded
		).toBe(true);
	});

	test("empty-Center actions force a Center item without reusing the active side route", async () => {
		localStorage.setItem("ryu_tab_open_behavior", "current");
		await renderProviders();
		let sideId = "";
		await act(async () => {
			sideId = currentTabs().openTab("/library/space", { title: "Library" });
		});
		await act(async () =>
			currentWorkbench().dispatch({ type: "region/show", region: "right" })
		);
		await act(async () =>
			currentWorkbench().moveItem(sideId, { region: "right" })
		);
		const originalSide = currentWorkbench().state.items.find(
			(item) => item.id === sideId
		);
		let libraryId = "";
		let settingsId = "";
		await act(async () => {
			libraryId = openTabFromEmptyCenter(
				currentTabs().openTab,
				"/library/agent",
				{ title: "Agents" }
			);
		});
		await act(async () => {
			settingsId = openTabFromEmptyCenter(currentTabs().openTab, "/settings", {
				title: "Settings",
			});
		});

		expect(
			currentWorkbench().state.items.find((item) => item.id === sideId)
		).toEqual(originalSide);
		expect(libraryId).not.toBe(sideId);
		expect(settingsId).not.toBe(sideId);
		const centerRouteIds = routeIdsInCenter(currentWorkbench());
		expect(centerRouteIds).toEqual(
			expect.arrayContaining([libraryId, settingsId])
		);
		let ordinaryNavigationId = "";
		await act(async () => {
			ordinaryNavigationId = currentTabs().openTab("/calendar");
		});
		expect(ordinaryNavigationId).toBe(settingsId);
	});
});
