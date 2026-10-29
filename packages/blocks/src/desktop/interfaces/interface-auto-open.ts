import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { isInterfaceCovered } from "./interface-keys.ts";

/**
 * Reading-pane interfaces (Inbox, Mail, Desk) open on their top conversation
 * the way a desktop mail or help-desk client does, instead of resting on a
 * blank pane. Once, after the first load, only when the window is wide enough
 * for the list and the pane to sit side by side, and never over a thread the
 * host already opened or a page it shows over the interface (a user who
 * returns from that page lands on the list). Opening goes through the port like any click, so the
 * host's own conversation surface (`threadView`) fills the pane.
 */
export function useAutoOpenFirstThread({
	activeThreadId,
	firstThreadId,
	loading,
	minWidth,
	openThread,
	rootRef,
	threadView,
}: {
	activeThreadId: string | null;
	/** The thread at the top of the list on screen, if any. */
	firstThreadId: string | null;
	loading: boolean;
	/** The narrowest root width (px) at which list and pane share the screen. */
	minWidth: number;
	openThread: (threadId: string) => void;
	rootRef: RefObject<HTMLElement | null>;
	threadView: ReactNode;
}): void {
	const done = useRef(false);
	useEffect(() => {
		if (done.current || loading) {
			return;
		}
		done.current = true;
		if (
			activeThreadId ||
			(threadView !== null && threadView !== undefined) ||
			isInterfaceCovered(rootRef.current)
		) {
			return;
		}
		const wide = (rootRef.current?.clientWidth ?? 0) >= minWidth;
		if (wide && firstThreadId) {
			openThread(firstThreadId);
		}
	}, [
		activeThreadId,
		firstThreadId,
		loading,
		minWidth,
		openThread,
		rootRef,
		threadView,
	]);
}
