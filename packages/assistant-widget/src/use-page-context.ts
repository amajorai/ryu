import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type BrowserPageContext,
	captureBrowserPageContext,
	readBrowserPageSelection,
} from "./browser-context.ts";

type PageSnapshot = Omit<BrowserPageContext, "selection">;

const EMPTY_PAGE: PageSnapshot = { text: "", title: "", url: "" };

/** Runs `task` when the main thread is idle, or on the next frame without idle callbacks. */
function whenIdle(task: () => void): () => void {
	if (typeof globalThis.requestIdleCallback === "function") {
		const id = globalThis.requestIdleCallback(task, { timeout: 1000 });
		return () => globalThis.cancelIdleCallback(id);
	}
	const frame = globalThis.requestAnimationFrame(task);
	return () => globalThis.cancelAnimationFrame(frame);
}

interface PageContextOptions {
	contextRootRef: RefObject<HTMLDivElement | null>;
	open: boolean;
	selection: string | null;
}

/**
 * Page text for the context chips. Walking the page reads computed styles for
 * every element, so it runs only while Ask Ryu is open, after the open
 * animation has had the main thread, and again synchronously at submit.
 */
export function usePageContext({
	contextRootRef,
	open,
	selection,
}: PageContextOptions): {
	capture: () => BrowserPageContext;
	context: BrowserPageContext;
} {
	const [page, setPage] = useState<PageSnapshot>(EMPTY_PAGE);
	const selectionRef = useRef(selection);

	useEffect(() => {
		selectionRef.current = selection;
	}, [selection]);

	const capture = useCallback((): BrowserPageContext => {
		const next = captureBrowserPageContext(
			document,
			contextRootRef.current,
			selectionRef.current ?? readBrowserPageSelection(document)
		);
		setPage({ text: next.text, title: next.title, url: next.url });
		return next;
	}, [contextRootRef]);

	useEffect(() => {
		if (!(open && globalThis.document)) {
			return;
		}
		const cancel = whenIdle(() => {
			capture();
		});
		const refreshPage = () => {
			capture();
		};
		// `pageshow` fires on window (bfcache restores), not on document.
		window.addEventListener("pageshow", refreshPage);
		return () => {
			cancel();
			window.removeEventListener("pageshow", refreshPage);
		};
	}, [capture, open]);

	const context = useMemo(
		(): BrowserPageContext => ({ ...page, selection }),
		[page, selection]
	);
	return { capture, context };
}
