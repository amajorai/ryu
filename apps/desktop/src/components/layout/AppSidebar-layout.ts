import { useEffect, useState } from "react";
import type { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import {
	DEFAULT_HIDDEN_CHROME,
	DEFAULT_HIDDEN_SECTIONS,
	FEATURES_CHANGED_EVENT,
	loadHiddenChrome,
	loadHiddenSections,
	persistHiddenChrome,
	persistHiddenSections,
} from "@/src/lib/features.ts";
import { useSidebarChromeLayout } from "./AppSidebar-chrome-layout.ts";
import { useSidebarSectionLayout } from "./AppSidebar-section-layout.ts";
import type { ChatSectionViews } from "./sidebar-chat-view.ts";
import type { SidebarModeDescriptor } from "./sidebar-modes.ts";
import { HEADER_BUTTON_CHROME } from "./sidebar-panel-state.tsx";
import { savePageSizes } from "./sidebar-scope-picker.tsx";
import { DEFAULT_SECTION_ORDER, type SectionKey } from "./sidebar-sections.ts";
import {
	type SortKey,
	saveChatSectionViews,
	saveSorts,
} from "./sidebar-sort-paging.ts";

/** The whole sidebar layout (sections + header buttons), the Customize dialog's
 *  open state, cross-surface re-sync, and the full layout reset. */
export function useSidebarLayout({
	activeMode,
	botProduct,
	contributedButtons,
	coreAppIds,
	dynamicSectionKeys,
}: {
	activeMode: SidebarModeDescriptor;
	botProduct: boolean;
	contributedButtons: ReturnType<
		typeof usePluginContributions
	>["sidebar_buttons"];
	coreAppIds: Set<string>;
	dynamicSectionKeys: SectionKey[];
}) {
	const [customizeOpen, setCustomizeOpen] = useState(false);
	const sectionLayout = useSidebarSectionLayout({
		activeMode,
		botProduct,
		dynamicSectionKeys,
		setCustomizeOpen,
	});
	const {
		reorderSections,
		setChatSectionViews,
		setHiddenSections,
		setSectionPageSizes,
		setSectionSorts,
	} = sectionLayout;
	const chromeLayout = useSidebarChromeLayout({
		botProduct,
		contributedButtons,
		coreAppIds,
	});
	const { reorderChrome, setHiddenChrome } = chromeLayout;

	// Re-sync hidden sections/chrome when another surface (Settings → Features,
	// the onboarding features step, or another window) changes them.
	useEffect(() => {
		const resync = () => {
			setHiddenSections(loadHiddenSections());
			setHiddenChrome(loadHiddenChrome());
		};
		window.addEventListener(FEATURES_CHANGED_EVENT, resync);
		window.addEventListener("storage", resync);
		return () => {
			window.removeEventListener(FEATURES_CHANGED_EVENT, resync);
			window.removeEventListener("storage", resync);
		};
	}, []);

	// Reset the full sidebar layout: default order, no page caps, and only the
	// opt-in sections/chrome hidden — matching a fresh install rather than
	// revealing every optional surface.
	const handleResetSidebar = () => {
		reorderSections([...DEFAULT_SECTION_ORDER]);
		reorderChrome([...HEADER_BUTTON_CHROME]);
		const clearedHidden = new Set<string>(DEFAULT_HIDDEN_SECTIONS);
		setHiddenSections(clearedHidden);
		persistHiddenSections(clearedHidden);
		const clearedChromeHidden = new Set<string>(DEFAULT_HIDDEN_CHROME);
		setHiddenChrome(clearedChromeHidden);
		persistHiddenChrome(clearedChromeHidden);
		setSectionPageSizes(() => {
			const next: Partial<Record<SectionKey, number>> = {};
			savePageSizes(next);
			return next;
		});
		setSectionSorts(() => {
			const next: Partial<Record<SectionKey, SortKey>> = {};
			saveSorts(next);
			return next;
		});
		setChatSectionViews(() => {
			const next: ChatSectionViews = {};
			saveChatSectionViews(next);
			return next;
		});
	};

	return {
		...sectionLayout,
		...chromeLayout,
		customizeOpen,
		handleResetSidebar,
		setCustomizeOpen,
	};
}
