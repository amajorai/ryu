import { type KeyboardEvent, type RefObject, useCallback, useRef } from "react";
import { ownsKeys, STEP_KEYS } from "./community-interface-view-state.ts";
import { type CommunityPost, stepPost } from "./community-model.ts";

/** What the front page's keyboard shortcuts read and drive. */
export interface CommunityKeyContext {
	composing: boolean;
	feed: CommunityPost[];
	navOpen: boolean;
	pageOpen: boolean;
	port: { closeThread: () => void };
	rowElements: RefObject<Map<string, HTMLButtonElement>>;
	searchRef: RefObject<HTMLInputElement | null>;
	setNavOpen: (open: boolean) => void;
}

/** Escape, `/`, and j/k (or arrow) row stepping on the front page. */
export function handleCommunityKeyDown(
	event: KeyboardEvent<HTMLDivElement>,
	context: CommunityKeyContext
) {
	const {
		composing,
		feed,
		navOpen,
		pageOpen,
		port,
		rowElements,
		searchRef,
		setNavOpen,
	} = context;
	if (
		event.defaultPrevented ||
		event.metaKey ||
		event.ctrlKey ||
		event.altKey
	) {
		return;
	}
	if (event.key === "Escape") {
		if (navOpen) {
			event.preventDefault();
			setNavOpen(false);
			return;
		}
		if (pageOpen && !ownsKeys(event.target)) {
			event.preventDefault();
			port.closeThread();
			return;
		}
	}
	if (ownsKeys(event.target)) {
		return;
	}
	if (event.key === "/") {
		event.preventDefault();
		searchRef.current?.focus();
		searchRef.current?.select();
		return;
	}
	const step = STEP_KEYS[event.key];
	if (step === undefined || pageOpen || composing) {
		return;
	}
	const order = feed.map((post) => post.thread.id);
	const focused = [...rowElements.current].find(
		([, element]) => element === document.activeElement
	)?.[0];
	const next = stepPost(order, focused ?? null, step);
	if (next) {
		event.preventDefault();
		const element = rowElements.current.get(next);
		element?.focus();
		element?.scrollIntoView?.({ block: "nearest" });
	}
}

/** The feed's row buttons by thread id, for focus stepping and restore. */
export function useRowRegistry() {
	const rowElements = useRef(new Map<string, HTMLButtonElement>());
	const registerRow = useCallback(
		(threadId: string, element: HTMLButtonElement | null) => {
			if (element) {
				rowElements.current.set(threadId, element);
			} else {
				rowElements.current.delete(threadId);
			}
		},
		[]
	);
	return { registerRow, rowElements };
}
