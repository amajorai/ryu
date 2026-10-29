import { useEffect, useRef } from "react";
import { useAssistantStore } from "@/src/store/useAssistantStore.ts";

/**
 * A new page re-offers its context: un-dismiss and forget removed chips when
 * the active tab changes. Called from the app shell, which stays mounted while
 * Ask Ryu is closed, floating, docked, or hidden behind the chat pane.
 */
export function useAssistantPageReset(activeTabId: string) {
	const restoreContext = useAssistantStore((s) => s.restoreContext);
	const lastTabRef = useRef(activeTabId);
	useEffect(() => {
		if (activeTabId !== lastTabRef.current) {
			lastTabRef.current = activeTabId;
			restoreContext();
		}
	}, [activeTabId, restoreContext]);
}
