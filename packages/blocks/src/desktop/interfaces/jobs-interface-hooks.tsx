import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import type { JobsTab } from "./jobs-rail.tsx";

const MINUTE = 60_000;
/** At or above this width the left rail (tabs, saved searches) shows. */
export const RAIL_MIN_WIDTH = 1180;
/** Below this width the filter pills wrap under the search box. */
export const COMPACT_MAX_WIDTH = 860;
/** Below this width the list and the detail take turns. */
export const STACKED_MAX_WIDTH = 720;
/** At or above this width full view keeps its details sidebar. */
export const FULL_SIDEBAR_MIN_WIDTH = 960;
const UNMEASURED_WIDTH = 1440;

/** Wall clock that ticks once a minute so relative times stay honest. */
export function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
		return () => window.clearInterval(timer);
	}, []);
	return now;
}

/** The element's rendered width, kept current with a ResizeObserver. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		setWidth(element.getBoundingClientRect().width);
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const next = entries[0]?.contentRect.width;
			if (next !== undefined) {
				setWidth(next);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width || UNMEASURED_WIDTH;
}

/** True for targets whose keys belong to typing, menus, or the host's chat. */
export function ownsKeys(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.closest("[data-testid='jobs-thread-view']") !== null
	);
}

export function DetailSkeleton() {
	return (
		<div
			aria-hidden="true"
			className="flex flex-1 flex-col gap-3 px-6 pt-5"
			data-testid="jobs-detail-skeleton"
		>
			<div className="flex items-center gap-2">
				<Skeleton className="size-8" radius="dense" />
				<Skeleton className="h-4 w-32" radius="dense" />
			</div>
			<Skeleton className="h-6 w-3/5" radius="dense" />
			<Skeleton className="h-4 w-2/5" radius="dense" />
			<Skeleton className="mt-4 h-24 w-full" radius="row" />
		</div>
	);
}

export function useRowRegistry() {
	const elements = useRef(new Map<string, HTMLElement>());
	const register = useCallback((id: string, element: HTMLElement | null) => {
		if (element) {
			elements.current.set(id, element);
		} else {
			elements.current.delete(id);
		}
	}, []);
	const focus = useCallback((id: string | undefined) => {
		if (!id) {
			return;
		}
		const element = elements.current.get(id);
		element?.focus({ preventScroll: true });
		element?.scrollIntoView?.({ block: "nearest" });
	}, []);
	return { elements, focus, register };
}

/** "/" focuses search from anywhere on the page (see JobsInterface). */
export function useSlashFocusSearch(
	rootRef: RefObject<HTMLDivElement | null>,
	searchRef: RefObject<HTMLInputElement | null>
): void {
	// "/" focuses search from anywhere on the page, not only from inside the
	// interface: on a fresh load, or after clicking plain text, focus sits on
	// the body. Typing targets and the host's chat keep their keys.
	useEffect(() => {
		const onKeyDownDocument = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key !== "/" ||
				event.defaultPrevented ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				ownsKeys(event.target)
			) {
				return;
			}
			const root = rootRef.current;
			const search = searchRef.current;
			if (
				!(root?.isConnected && search) ||
				root.getClientRects().length === 0
			) {
				return;
			}
			const target = event.target;
			// Inside another surface (a dialog, another pane) the key is theirs.
			if (
				target instanceof Node &&
				target !== document.body &&
				!root.contains(target)
			) {
				return;
			}
			event.preventDefault();
			search.focus();
		};
		document.addEventListener("keydown", onKeyDownDocument);
		return () => document.removeEventListener("keydown", onKeyDownDocument);
	}, [rootRef, searchRef]);
}

/** Keeps the tab, cursor, and full view in step with the host's open thread. */
export function useJobsThreadSync({
	activeThreadId,
	conversationOpen,
	setCursorId,
	setFullView,
	setTab,
}: {
	activeThreadId: string | null | undefined;
	conversationOpen: boolean;
	setCursorId: (id: string | null) => void;
	setFullView: (next: boolean) => void;
	setTab: (next: JobsTab) => void;
}): void {
	// A thread opened from anywhere (host, history, a new post) is a job.
	useEffect(() => {
		if (activeThreadId) {
			setTab("jobs");
			setCursorId(activeThreadId);
		}
	}, [activeThreadId, setCursorId, setTab]);

	useEffect(() => {
		if (!conversationOpen) {
			setFullView(false);
		}
	}, [conversationOpen, setFullView]);
}
