import { useEffect } from "react";
import { useIsActiveTab } from "@/src/contexts/TabsContext.tsx";
import {
	type PageContextItem,
	useAssistantStore,
} from "@/src/store/useAssistantStore.ts";

/**
 * Publish the current page's content to the global "Ask Ryu" assistant so it
 * can answer with that context (Notion-AI style). A page calls this with a
 * snapshot of what the user is looking at; the assistant panel shows it as a
 * removable chip and embeds it into the first message of a fresh thread.
 *
 * Only the ACTIVE tab publishes — every chat/editor tab stays mounted at once
 * (see Layout), so gating on `useIsActiveTab` keeps a background tab from
 * stealing the context slot. The context is cleared when the page unmounts or
 * stops being the focused tab, so the assistant falls back to the generic
 * "current page" context the panel derives on its own.
 *
 * Pass `null` to publish nothing (e.g. while the page is still loading).
 */
export function useAssistantPageContext(item: PageContextItem | null): void {
	const isActive = useIsActiveTab();
	const setPageContext = useAssistantStore((s) => s.setPageContext);

	const id = item?.id;
	const title = item?.title;
	const text = item?.text;

	useEffect(() => {
		if (!(isActive && id && title)) {
			return;
		}
		setPageContext([{ id, title, text: text ?? "" }]);
		return () => setPageContext([]);
	}, [isActive, id, title, text, setPageContext]);
}
