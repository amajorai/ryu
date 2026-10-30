import { useReorderShift } from "@ryu/ui/hooks/use-reorder-shift.tsx";
import { type Dispatch, type SetStateAction, useMemo, useState } from "react";
import {
	loadHiddenSections,
	persistHiddenSections,
	SECTION_HIDDEN_KEY,
} from "@/src/lib/features.ts";
import type { ChatSectionView, ChatSectionViews } from "./sidebar-chat-view.ts";
import {
	AGENT_MODE_SECTIONS,
	orderedSidebarModeSections,
	type SidebarModeDescriptor,
} from "./sidebar-modes.ts";
import {
	loadIdSet,
	SECTION_COLLAPSED_KEY,
	SECTION_PAGE_SIZE_KEY,
	SECTION_SORT_KEY,
	saveIdSet,
} from "./sidebar-panel-state.tsx";
import { loadPageSizes, savePageSizes } from "./sidebar-scope-picker.tsx";
import type { SectionDnd, SectionMenu } from "./sidebar-section.tsx";
import {
	isDynamicSectionKey,
	loadSectionOrder,
	migrateLegacySectionStorage,
	SECTION_ORDER_KEY,
	type SectionKey,
	saveSectionOrder,
} from "./sidebar-sections.ts";
import {
	loadChatSectionViews,
	loadSorts,
	type SortKey,
	saveChatSectionViews,
	saveSorts,
} from "./sidebar-sort-paging.ts";

/** The sidebar's section layout: persisted order, collapse/hide state, page
 *  sizes, sorts and chat views, plus every reorder/move/hide writer. */
export function useSidebarSectionLayout({
	activeMode,
	botProduct,
	dynamicSectionKeys,
	setCustomizeOpen,
}: {
	activeMode: SidebarModeDescriptor;
	botProduct: boolean;
	dynamicSectionKeys: SectionKey[];
	setCustomizeOpen: Dispatch<SetStateAction<boolean>>;
}) {
	const [sectionOrder, setSectionOrder] = useState<SectionKey[]>(() => {
		migrateLegacySectionStorage(localStorage, {
			arrays: [SECTION_ORDER_KEY, SECTION_COLLAPSED_KEY, SECTION_HIDDEN_KEY],
			records: [SECTION_PAGE_SIZE_KEY, SECTION_SORT_KEY],
		});
		return loadSectionOrder();
	});
	const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
		() => {
			// Default the Archived section to collapsed on first run, so it stays out
			// of the way until the user opens it. Once they toggle anything, their
			// stored preference wins.
			const stored = localStorage.getItem(SECTION_COLLAPSED_KEY);
			return stored ? loadIdSet(SECTION_COLLAPSED_KEY) : new Set(["archived"]);
		}
	);
	const [draggingKey, setDraggingKey] = useState<SectionKey | null>(null);
	const [dragOverKey, setDragOverKey] = useState<SectionKey | null>(null);
	const sectionShift = useReorderShift({
		activeId: draggingKey,
		axis: "y",
		overId: dragOverKey,
	});
	const [hiddenSections, setHiddenSections] =
		useState<Set<string>>(loadHiddenSections);
	const [sectionPageSizes, setSectionPageSizes] =
		useState<Partial<Record<SectionKey, number>>>(loadPageSizes);
	const [sectionSorts, setSectionSorts] =
		useState<Partial<Record<SectionKey, SortKey>>>(loadSorts);
	const [chatSectionViews, setChatSectionViews] =
		useState<ChatSectionViews>(loadChatSectionViews);

	const toggleInSet = (
		setter: Dispatch<SetStateAction<Set<string>>>,
		key: string,
		id: string
	) => {
		setter((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			saveIdSet(key, next);
			return next;
		});
	};

	const handleToggleSection = (key: SectionKey) =>
		toggleInSet(setCollapsedSections, SECTION_COLLAPSED_KEY, key);

	// Projects now live nested under the single Projects section, so the rendered
	// order is just the persisted built-in order (loadSectionOrder already drops any
	// stale per-project keys from older versions and splices in "projects").
	// The persisted built-in order, plus any app-contributed dynamic sections not yet
	// in it (appended in `order` order). A dynamic key the user has already arranged
	// stays in its stored position (loadSectionOrder preserves `plugin:` keys).
	const effectiveOrder: SectionKey[] = useMemo(() => {
		const missing = dynamicSectionKeys.filter((k) => !sectionOrder.includes(k));
		return missing.length > 0 ? [...sectionOrder, ...missing] : sectionOrder;
	}, [sectionOrder, dynamicSectionKeys]);
	const liveDynamicKeys = useMemo(
		() => new Set(dynamicSectionKeys),
		[dynamicSectionKeys]
	);
	const renderOrder: SectionKey[] = botProduct
		? ["chats"]
		: activeMode.key === "agent"
			? AGENT_MODE_SECTIONS
			: activeMode.key === "computers"
				? orderedSidebarModeSections(activeMode, effectiveOrder)
				: effectiveOrder.filter(
						(key) => !isDynamicSectionKey(key) || liveDynamicKeys.has(key)
					);

	// The single writer for section order: every reorder path (drag, the per-section
	// move-up/down menu, and the customize dialog) funnels through here so they can
	// never drift out of sync. Reorders persist the reconciled `effectiveOrder`, so
	// project positions bake into the stored order once the user arranges anything.
	const reorderSections = (next: SectionKey[]) => {
		setSectionOrder(next);
		saveSectionOrder(next);
	};

	// Move the dragged section next to where it was dropped. Dropping below the
	// original position inserts after the target (and above inserts before) so
	// every slot, including the last, is reachable.
	const handleDropSection = (target: SectionKey) => {
		if (draggingKey && draggingKey !== target) {
			const draggingDown =
				effectiveOrder.indexOf(draggingKey) < effectiveOrder.indexOf(target);
			const next = effectiveOrder.filter((k) => k !== draggingKey);
			const targetIdx = next.indexOf(target);
			next.splice(draggingDown ? targetIdx + 1 : targetIdx, 0, draggingKey);
			reorderSections(next);
		}
		setDraggingKey(null);
		setDragOverKey(null);
	};

	// Move/hide operate relative to the visible sections, so a move never swaps a
	// section with a hidden one (which would read as "nothing happened").
	const visibleSectionOrder = renderOrder.filter((k) => !hiddenSections.has(k));

	const canMoveSection = (key: SectionKey, dir: "up" | "down") => {
		const idx = visibleSectionOrder.indexOf(key);
		if (idx === -1) {
			return false;
		}
		return dir === "up" ? idx > 0 : idx < visibleSectionOrder.length - 1;
	};

	const handleMoveSection = (key: SectionKey, dir: "up" | "down") => {
		const idx = visibleSectionOrder.indexOf(key);
		const neighbor =
			dir === "up"
				? visibleSectionOrder[idx - 1]
				: visibleSectionOrder[idx + 1];
		if (!neighbor) {
			return;
		}
		const next = renderOrder.filter((k) => k !== key);
		const neighborIdx = next.indexOf(neighbor);
		next.splice(dir === "up" ? neighborIdx : neighborIdx + 1, 0, key);
		reorderSections(next);
	};

	const setSectionHidden = (key: SectionKey, hidden: boolean) => {
		// Load fresh so a concurrent writer (e.g. the Settings → Features tab open
		// at the same time) isn't clobbered by a stale snapshot; persist dispatches
		// the change event, which other surfaces re-sync from.
		const next = loadHiddenSections();
		if (hidden) {
			next.add(key);
		} else {
			next.delete(key);
		}
		setHiddenSections(next);
		persistHiddenSections(next);
	};

	const setSectionsHidden = (keys: SectionKey[], hidden: boolean) => {
		const next = loadHiddenSections();
		for (const key of keys) {
			if (hidden) {
				next.add(key);
			} else {
				next.delete(key);
			}
		}
		setHiddenSections(next);
		persistHiddenSections(next);
	};

	const handleSetPageSize = (key: SectionKey, size: number) => {
		setSectionPageSizes((prev) => {
			const next = { ...prev, [key]: size };
			savePageSizes(next);
			return next;
		});
	};

	const handleSetSort = (key: SectionKey, sort: SortKey) => {
		setSectionSorts((prev) => {
			const next = { ...prev, [key]: sort };
			saveSorts(next);
			return next;
		});
	};

	const handleSetChatView = (key: SectionKey, view: ChatSectionView) => {
		setChatSectionViews((prev) => {
			const next = { ...prev, [key]: view };
			saveChatSectionViews(next);
			return next;
		});
	};

	// Collapse/expand every section at once (the sidebar root context menu). Uses
	// the full effective order, so hidden sections fold too — harmless, and keeps
	// the stored set consistent when a section is later un-hidden.
	const handleCollapseAll = () => {
		setCollapsedSections(() => {
			const next = new Set<string>(effectiveOrder);
			saveIdSet(SECTION_COLLAPSED_KEY, next);
			return next;
		});
	};

	const handleExpandAll = () => {
		setCollapsedSections(() => {
			const next = new Set<string>();
			saveIdSet(SECTION_COLLAPSED_KEY, next);
			return next;
		});
	};

	const sectionMenu: SectionMenu = {
		canMove: canMoveSection,
		onMove: handleMoveSection,
		onHide: (key) => setSectionHidden(key, true),
		onSetChatView: handleSetChatView,
		onSetPageSize: handleSetPageSize,
		onSetSort: handleSetSort,
		onOpenCustomize: () => setCustomizeOpen(true),
	};

	const sectionDnd: SectionDnd = {
		draggingKey,
		dragOverKey,
		order: renderOrder,
		onDragStart: setDraggingKey,
		onDragEnd: () => {
			setDraggingKey(null);
			setDragOverKey(null);
		},
		onDragOver: (key) => setDragOverKey((prev) => (prev === key ? prev : key)),
		// Drop on the resolved target, not the (shifted) section under the pointer.
		onDrop: (key) => handleDropSection(dragOverKey ?? key),
		shift: sectionShift,
	};

	return {
		chatSectionViews,
		collapsedSections,
		handleCollapseAll,
		handleExpandAll,
		handleToggleSection,
		hiddenSections,
		renderOrder,
		reorderSections,
		sectionDnd,
		sectionMenu,
		sectionPageSizes,
		sectionSorts,
		setChatSectionViews,
		setHiddenSections,
		setSectionHidden,
		setSectionPageSizes,
		setSectionSorts,
		setSectionsHidden,
	};
}
