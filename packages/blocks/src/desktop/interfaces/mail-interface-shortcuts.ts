import { type KeyboardEvent, type RefObject, useEffect } from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import { ownsKeys, useEffectEventLike } from "./mail-interface-hooks.ts";
import { mailCursorStep } from "./mail-model.ts";

interface MailShortcutsOptions {
	activeIndex: number;
	closeThread: () => void;
	conversationOpen: boolean;
	cursor: string | null;
	moveCursorTo: (threadId: string | undefined) => void;
	openCompose: () => void;
	openThread: (threadId: string) => void;
	order: string[];
	rootRef: RefObject<HTMLDivElement | null>;
	searchRef: RefObject<HTMLInputElement | null>;
	showList: boolean;
	stepConversation: (step: "next" | "previous") => void;
	stepCursor: (step: "next" | "previous") => void;
	toggleSelected: (threadId: string) => void;
}

/**
 * Mail's keyboard: arrow/Home/End movement on the rows, plus Gmail's
 * single-key shortcuts on the document. Returns the row key handler.
 */
export function useMailShortcuts({
	activeIndex,
	closeThread,
	conversationOpen,
	cursor,
	moveCursorTo,
	openCompose,
	openThread,
	order,
	rootRef,
	searchRef,
	showList,
	stepConversation,
	stepCursor,
	toggleSelected,
}: MailShortcutsOptions) {
	const onKeyDownRow = (
		event: KeyboardEvent<HTMLElement>,
		threadId: string
	) => {
		if (event.metaKey || event.ctrlKey || event.altKey) {
			return;
		}
		const index = order.indexOf(threadId);
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const target =
				event.key === "ArrowDown"
					? Math.min(index + 1, order.length - 1)
					: Math.max(index - 1, 0);
			moveCursorTo(order[target]);
			return;
		}
		if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			moveCursorTo(event.key === "Home" ? order[0] : order.at(-1));
		}
	};

	// Gmail's single-key shortcuts, kept out of typing and the host's chat.
	const onDocumentKey = useEffectEventLike(
		(event: globalThis.KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				ownsKeys(event.target) ||
				isInterfaceCovered(rootRef.current)
			) {
				return;
			}
			const root = rootRef.current;
			const target = event.target;
			const fromPage =
				target === document.body || target === document.documentElement;
			if (
				!(
					root &&
					(fromPage || (target instanceof Node && root.contains(target)))
				)
			) {
				return;
			}
			const step = mailCursorStep(event.key);
			if (step && !event.key.startsWith("Arrow")) {
				event.preventDefault();
				if (conversationOpen && activeIndex !== -1) {
					stepConversation(step);
				} else {
					stepCursor(step);
				}
				return;
			}
			switch (event.key) {
				case "c":
					event.preventDefault();
					openCompose();
					return;
				case "/":
					event.preventDefault();
					searchRef.current?.focus();
					return;
				case "u":
					if (conversationOpen) {
						event.preventDefault();
						closeThread();
					}
					return;
				case "x":
					if (cursor && showList) {
						event.preventDefault();
						toggleSelected(cursor);
					}
					return;
				case "o":
					if (cursor && showList) {
						event.preventDefault();
						openThread(cursor);
					}
					return;
				case "Enter":
					if (cursor && showList && fromPage) {
						event.preventDefault();
						openThread(cursor);
					}
					return;
				default:
			}
		}
	);
	useEffect(() => {
		document.addEventListener("keydown", onDocumentKey);
		return () => document.removeEventListener("keydown", onDocumentKey);
	}, [onDocumentKey]);

	return onKeyDownRow;
}
