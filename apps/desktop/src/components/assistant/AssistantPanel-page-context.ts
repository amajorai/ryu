import { useEffect, useMemo, useRef } from "react";
import type { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import type { PageContextItem } from "@/src/store/useAssistantStore.ts";
import { tabContextTitle } from "./AssistantPanel-request.ts";

type TabsContext = ReturnType<typeof useTabsContext>;

/** The page context the panel offers: published items, else the focused tab. */
export function useAssistantPageContext({
	activeTabId,
	contextDismissed,
	pageContext,
	restoreContext,
	tabs,
}: {
	activeTabId: TabsContext["activeTabId"];
	contextDismissed: boolean;
	pageContext: PageContextItem[];
	restoreContext: () => void;
	tabs: TabsContext["tabs"];
}) {
	// The generic "current page" context derived from the focused tab, offered
	// when the active page hasn't published anything richer of its own.
	const genericContext = useMemo<PageContextItem | null>(() => {
		const tab = tabs.find((t) => t.id === activeTabId);
		if (!tab) {
			return null;
		}
		return {
			id: `tab:${tab.id}`,
			title: tabContextTitle(tab.title, tab.path),
			text: `The user is on the "${tabContextTitle(tab.title, tab.path)}" page (${tab.path}).`,
		};
	}, [tabs, activeTabId]);

	// A new page is a new context opportunity — un-dismiss when the focus moves.
	const lastTabRef = useRef(activeTabId);
	useEffect(() => {
		if (activeTabId !== lastTabRef.current) {
			lastTabRef.current = activeTabId;
			restoreContext();
		}
	}, [activeTabId, restoreContext]);

	const effectiveContext = useMemo<PageContextItem[]>(() => {
		if (contextDismissed) {
			return [];
		}
		if (pageContext.length > 0) {
			return pageContext;
		}
		return genericContext ? [genericContext] : [];
	}, [contextDismissed, pageContext, genericContext]);
	const effectiveContextRef = useRef(effectiveContext);
	effectiveContextRef.current = effectiveContext;
	return { effectiveContext, effectiveContextRef, genericContext };
}
