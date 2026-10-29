import {
	ArrowReloadHorizontalIcon,
	LayoutBottomIcon,
	LayoutGridIcon,
	LayoutRightIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type {
	BottomAlignment,
	WorkbenchRegion,
	WorkbenchSplitNode,
	WorkbenchState,
} from "@ryu/workbench/model";
import type { WorkbenchAction } from "@ryu/workbench/reducer";

const REGION_NAMES = {
	bottom: "Bottom",
	center: "Center",
	left: "Left",
	right: "Right",
} satisfies Record<WorkbenchRegion, string>;

const BOTTOM_ALIGNMENTS = [
	["center", "Center"],
	["full", "Full Width"],
	["left", "Left"],
	["right", "Right"],
] as const satisfies ReadonlyArray<readonly [BottomAlignment, string]>;

export interface WorkbenchCommand {
	checked?: boolean;
	disabled?: boolean;
	icon: IconSvgElement;
	id: string;
	keywords: string;
	run: () => void;
	title: string;
}

function centerLeafIds(tree: WorkbenchSplitNode): string[] {
	return tree.type === "leaf"
		? [tree.groupId]
		: tree.children.flatMap(centerLeafIds);
}

function branchPaths(
	tree: WorkbenchSplitNode,
	path: number[] = []
): Array<{ count: number; path: number[] }> {
	if (tree.type === "leaf") {
		return [];
	}
	return [
		{ count: tree.children.length, path },
		...tree.children.flatMap((child, index) =>
			branchPaths(child, [...path, index])
		),
	];
}

function regionHasTabs(state: WorkbenchState, region: WorkbenchRegion) {
	return state.groups.some(
		(group) => group.region === region && group.itemIds.length > 0
	);
}

/**
 * Visible groups in reading order: Left, Center panes (split order), Right,
 * then Bottom. Used to cycle keyboard focus between panes.
 */
export function visibleGroupOrder(
	state: WorkbenchState,
	movableRegions: readonly WorkbenchRegion[]
): string[] {
	const sideGroup = (region: Exclude<WorkbenchRegion, "center">) =>
		movableRegions.includes(region) &&
		state.openRegions[region] &&
		regionHasTabs(state, region)
			? state.groups
					.filter((group) => group.region === region)
					.map((group) => group.id)
			: [];
	return [
		...sideGroup("left"),
		...centerLeafIds(state.centerTree),
		...sideGroup("right"),
		...sideGroup("bottom"),
	];
}

/** The group that keyboard focus moves to from the focused one. */
export function adjacentGroupId(
	state: WorkbenchState,
	movableRegions: readonly WorkbenchRegion[],
	delta: -1 | 1
): string | undefined {
	const order = visibleGroupOrder(state, movableRegions);
	if (order.length < 2) {
		return undefined;
	}
	const index = Math.max(0, order.indexOf(state.focusedGroupId));
	return order[(index + delta + order.length) % order.length];
}

/**
 * Move keyboard focus to a group's active tab once it has rendered, so a
 * focus command lands where arrow keys and Enter act next.
 */
export function focusGroupElement(groupId: string): void {
	if (typeof document === "undefined") {
		return;
	}
	requestAnimationFrame(() => {
		document
			.querySelector<HTMLElement>(
				`[data-group-id="${CSS.escape(groupId)}"] [role="tab"][tabindex="0"]`
			)
			?.focus();
	});
}

/** Give every split in Center equal space. */
export function equalizeCenterActions(
	tree: WorkbenchSplitNode
): WorkbenchAction[] {
	return branchPaths(tree).map(({ count, path }) => ({
		type: "center/resize-branch",
		path,
		sizes: Array.from({ length: count }, () => 1 / count),
	}));
}

/** Merge every Center pane into the first one, keeping all tabs. */
export function joinCenterActions(tree: WorkbenchSplitNode): WorkbenchAction[] {
	return centerLeafIds(tree)
		.slice(1)
		.map((groupId) => ({ type: "center/remove-group", groupId }));
}

/**
 * Layout commands for the command palette. Pure: it reads the current state
 * and returns commands whose `run` dispatches reducer actions, so the palette,
 * hotkeys, and tests share one definition.
 */
export function workbenchLayoutCommands({
	dispatch,
	movableRegions,
	state,
}: {
	dispatch: (action: WorkbenchAction) => void;
	movableRegions: readonly WorkbenchRegion[];
	state: WorkbenchState;
}): WorkbenchCommand[] {
	const commands: WorkbenchCommand[] = [];
	for (const region of ["right", "bottom"] as const) {
		const open = state.openRegions[region];
		const name = REGION_NAMES[region];
		commands.push({
			disabled: !regionHasTabs(state, region),
			icon: region === "right" ? LayoutRightIcon : LayoutBottomIcon,
			id: `workbench-toggle-${region}`,
			keywords: `${open ? "hide" : "show"} toggle ${region} pane panel region layout`,
			run: () =>
				dispatch(
					open
						? { type: "region/hide", region }
						: { type: "region/show", region }
				),
			title: `${open ? "Hide" : "Show"} ${name} Pane`,
		});
	}

	const focusedGroup = state.groups.find(
		(group) => group.id === state.focusedGroupId
	);
	const activeItemId = focusedGroup?.activeItemId ?? null;
	for (const region of movableRegions) {
		if (region === "left") {
			continue;
		}
		const name = REGION_NAMES[region];
		commands.push({
			disabled: !activeItemId || focusedGroup?.region === region,
			icon: region === "bottom" ? LayoutBottomIcon : LayoutRightIcon,
			id: `workbench-move-to-${region}`,
			keywords: `move tab to ${region} pane region layout`,
			run: () => {
				const targetId =
					region === "center"
						? centerLeafIds(state.centerTree)[0]
						: state.groups.find((group) => group.region === region)?.id;
				if (activeItemId && targetId) {
					dispatch({
						type: "item/move",
						itemId: activeItemId,
						toGroupId: targetId,
					});
				}
			},
			title: `Move Tab to ${name} Pane`,
		});
	}

	for (const [alignment, label] of BOTTOM_ALIGNMENTS) {
		commands.push({
			checked: state.bottomAlignment === alignment,
			icon: LayoutBottomIcon,
			id: `workbench-align-bottom-${alignment}`,
			keywords: `align bottom pane panel width ${label.toLowerCase()} layout`,
			run: () => dispatch({ type: "bottom/align", alignment }),
			title: `Align Bottom Pane: ${label}`,
		});
	}

	const multipleCenterPanes = state.centerTree.type === "branch";
	commands.push(
		{
			disabled: !multipleCenterPanes,
			icon: LayoutGridIcon,
			id: "workbench-equalize-center",
			keywords: "equalize even split panes sizes center layout",
			run: () => {
				for (const action of equalizeCenterActions(state.centerTree)) {
					dispatch(action);
				}
			},
			title: "Equalize Center Panes",
		},
		{
			disabled: !multipleCenterPanes,
			icon: LayoutGridIcon,
			id: "workbench-join-center",
			keywords: "join merge close split panes center unsplit layout",
			run: () => {
				for (const action of joinCenterActions(state.centerTree)) {
					dispatch(action);
				}
			},
			title: "Join Center Panes",
		}
	);

	for (const [delta, label] of [
		[1, "Next"],
		[-1, "Previous"],
	] as const) {
		const target = adjacentGroupId(state, movableRegions, delta);
		commands.push({
			disabled: !target,
			icon: LayoutGridIcon,
			id: `workbench-focus-${label.toLowerCase()}-pane`,
			keywords: `focus ${label.toLowerCase()} pane group region layout`,
			run: () => {
				if (target) {
					dispatch({ type: "group/focus", groupId: target });
					focusGroupElement(target);
				}
			},
			title: `Focus ${label} Pane`,
		});
	}

	const navigation = state.items.find(
		(item) => item.source.kind === "navigation"
	);
	const navigationGroup = state.groups.find(
		(group) => navigation !== undefined && group.itemIds.includes(navigation.id)
	);
	if (navigation && navigationGroup) {
		const atLeft = navigationGroup.region === "left";
		const target = atLeft
			? state.groups.find((group) => group.region === "right")
			: state.groups.find((group) => group.region === "left");
		commands.push({
			disabled: !target,
			icon: atLeft ? LayoutRightIcon : LayoutGridIcon,
			id: atLeft ? "workbench-navigation-right" : "workbench-navigation-left",
			keywords: "move navigation sidebar side bar position left right layout",
			run: () => {
				if (target) {
					dispatch({
						type: "item/move",
						itemId: navigation.id,
						toGroupId: target.id,
					});
				}
			},
			title: atLeft ? "Move Navigation to Right" : "Move Navigation to Left",
		});
	}

	commands.push({
		icon: ArrowReloadHorizontalIcon,
		id: "workbench-reset-layout",
		keywords: "reset layout panes regions default restore",
		run: () => dispatch({ type: "layout/reset" }),
		title: "Reset Layout",
	});
	return commands;
}
