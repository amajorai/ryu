import type { Dispatch, SetStateAction } from "react";
import {
	type DockSide,
	type DockTabKind,
	isPinnableDockTabKind,
} from "@/src/components/panels/dock-panels.ts";
import type {
	ProjectDockTab,
	useProjectDockStore,
} from "@/src/store/useProjectDockStore.ts";
import type { TabKind, TabTypeDef } from "./tab-model.ts";
import { PAGE_TAB_TYPES } from "./tab-model.ts";
import type { usePanelTabs } from "./use-panel-tabs.ts";
import type { WorkspacePanelsProps } from "./workspace-panels-types.ts";

type PanelTabsState = ReturnType<typeof usePanelTabs>;
type ProjectDockState = ReturnType<typeof useProjectDockStore.getState>;
type SetUid = Dispatch<SetStateAction<string>>;

interface DockTabActionsInput
	extends Pick<
		WorkspacePanelsProps,
		| "bottomOpen"
		| "folder"
		| "onBottomOpenChange"
		| "onRightOpenChange"
		| "rightOpen"
	> {
	addProjectTab: ProjectDockState["addTab"];
	bottomLocal: PanelTabsState;
	bottomTabTypes: TabTypeDef[];
	currentTabId: string | null | undefined;
	projectTabs: ProjectDockTab[];
	removeProjectTab: ProjectDockState["removeTab"];
	rightLocal: PanelTabsState;
	rightTabTypes: TabTypeDef[];
	setBottomActiveUid: SetUid;
	setProjectSide: ProjectDockState["setSide"];
	setRightActiveUid: SetUid;
	toggleProjectPin: ProjectDockState["togglePin"];
	visibleBottomProject: ProjectDockTab[];
	visibleRightProject: ProjectDockTab[];
}

/**
 * The tab-strip actions of both docks: add, close, close others/all, pin, and
 * move a tab between the bottom and right docks. Project-shareable tabs go
 * through the project dock store; chat-local ones through the panel-tab state.
 */
export function dockTabActions({
	addProjectTab,
	bottomLocal,
	bottomOpen,
	bottomTabTypes,
	currentTabId,
	folder,
	onBottomOpenChange,
	onRightOpenChange,
	projectTabs,
	removeProjectTab,
	rightLocal,
	rightOpen,
	rightTabTypes,
	setBottomActiveUid,
	setProjectSide,
	setRightActiveUid,
	toggleProjectPin,
	visibleBottomProject,
	visibleRightProject,
}: DockTabActionsInput) {
	const addToProject = (
		side: DockSide,
		kind: DockTabKind,
		label: string,
		visible: ProjectDockTab[]
	) => {
		if (!(folder && currentTabId)) {
			return null;
		}
		const sameKind = visible.filter((t) => t.kind === kind);
		return addProjectTab(folder, {
			kind,
			label: sameKind.length === 0 ? label : `${label} ${sameKind.length + 1}`,
			side,
			pinned: false,
			ownerTabId: currentTabId,
		});
	};

	// ── Reusable panel cards (shared by docked + floating-peek renders) ──────────

	const addBottomTab = (kind: TabKind) => {
		const label = bottomTabTypes.find((t) => t.kind === kind)?.label ?? kind;
		if (folder && kind !== "unavailable" && isPinnableDockTabKind(kind)) {
			const entry = addToProject("bottom", kind, label, visibleBottomProject);
			if (entry) {
				setBottomActiveUid(entry.uid);
				return;
			}
		}
		bottomLocal.addTab(kind, label);
	};
	const addRightTab = (kind: TabKind) => {
		// Pages are offered from the "+" menu's submenu, so their labels live in
		// `PAGE_TAB_TYPES` rather than in `rightTabTypes` — without them in the
		// lookup a page tab would be titled with its raw `route:/…` kind.
		const label =
			rightTabTypes.find((t) => t.kind === kind)?.label ??
			PAGE_TAB_TYPES.find((t) => t.kind === kind)?.label ??
			kind;
		if (folder && kind !== "unavailable" && isPinnableDockTabKind(kind)) {
			const entry = addToProject("right", kind, label, visibleRightProject);
			if (entry) {
				setRightActiveUid(entry.uid);
				return;
			}
		}
		rightLocal.addTab(kind, label);
	};

	const closeBottomTab = (uid: string) => {
		if (folder && projectTabs.some((t) => t.uid === uid)) {
			removeProjectTab(folder, uid);
			return;
		}
		bottomLocal.closeTab(uid);
	};
	const closeRightTab = (uid: string) => {
		if (folder && projectTabs.some((t) => t.uid === uid)) {
			removeProjectTab(folder, uid);
			return;
		}
		rightLocal.closeTab(uid);
	};

	const closeBottomOthers = (uid: string) => {
		if (folder) {
			for (const t of visibleBottomProject) {
				if (t.uid !== uid && !t.pinned) {
					removeProjectTab(folder, t.uid);
				}
			}
		}
		if (bottomLocal.tabs.some((t) => t.uid === uid)) {
			bottomLocal.closeOthers(uid);
		} else {
			bottomLocal.closeAll();
		}
		setBottomActiveUid(uid);
	};
	const closeRightOthers = (uid: string) => {
		if (folder) {
			for (const t of visibleRightProject) {
				if (t.uid !== uid && !t.pinned) {
					removeProjectTab(folder, t.uid);
				}
			}
		}
		if (rightLocal.tabs.some((t) => t.uid === uid)) {
			rightLocal.closeOthers(uid);
		} else {
			rightLocal.closeAll();
		}
		setRightActiveUid(uid);
	};

	const closeBottomAll = () => {
		if (folder) {
			for (const t of visibleBottomProject) {
				if (!t.pinned) {
					removeProjectTab(folder, t.uid);
				}
			}
		}
		bottomLocal.closeAll();
		const pinnedLeft = visibleBottomProject.find((t) => t.pinned);
		setBottomActiveUid(pinnedLeft?.uid ?? "");
	};
	const closeRightAll = () => {
		if (folder) {
			for (const t of visibleRightProject) {
				if (!t.pinned) {
					removeProjectTab(folder, t.uid);
				}
			}
		}
		rightLocal.closeAll();
		const pinnedLeft = visibleRightProject.find((t) => t.pinned);
		setRightActiveUid(pinnedLeft?.uid ?? "");
	};

	const onTogglePin = (uid: string) => {
		if (!folder) {
			return;
		}
		toggleProjectPin(folder, uid, currentTabId ?? undefined);
	};

	// Move a tab between the two docks, preserving its identity, and reveal the
	// destination dock if it was closed so the moved tab is visible.
	const moveTabToRight = (uid: string) => {
		const projectTab = projectTabs.find((t) => t.uid === uid);
		if (folder && projectTab) {
			setProjectSide(folder, uid, "right");
			setRightActiveUid(uid);
			if (!rightOpen) {
				onRightOpenChange(true);
			}
			return;
		}
		const tab = bottomLocal.tabs.find((t) => t.uid === uid);
		if (!tab) {
			return;
		}
		bottomLocal.closeTab(uid);
		rightLocal.adoptTab(tab);
		if (!rightOpen) {
			onRightOpenChange(true);
		}
	};
	const moveTabToBottom = (uid: string) => {
		const projectTab = projectTabs.find((t) => t.uid === uid);
		if (folder && projectTab) {
			setProjectSide(folder, uid, "bottom");
			setBottomActiveUid(uid);
			if (!bottomOpen) {
				onBottomOpenChange(true);
			}
			return;
		}
		const tab = rightLocal.tabs.find((t) => t.uid === uid);
		if (!tab) {
			return;
		}
		rightLocal.closeTab(uid);
		bottomLocal.adoptTab(tab);
		if (!bottomOpen) {
			onBottomOpenChange(true);
		}
	};

	const pinDisabledReason = folder
		? undefined
		: "Open a project to pin and share tabs across chats";
	return {
		addBottomTab,
		addRightTab,
		closeBottomAll,
		closeBottomOthers,
		closeBottomTab,
		closeRightAll,
		closeRightOthers,
		closeRightTab,
		moveTabToBottom,
		moveTabToRight,
		onTogglePin,
		pinDisabledReason,
	};
}
