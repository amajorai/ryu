import type { InterfacePort } from "@ryuhq/protocol/interfaces";
import {
	type KeyboardEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";

/** How long a requested focus move may wait for the host to open or close. */
const FOCUS_REQUEST_TTL_MS = 2000;

interface FocusRequest {
	at: number;
	to: "opener" | "panel";
}

/** Escape inside a text field belongs to the field (or the host's composer). */
function isEditable(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.closest("input, textarea, select, [contenteditable='true']") !== null
	);
}

/** Wall-clock time that advances on an interval, so "today" rolls over. */
export function useNow(interval: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), interval);
		return () => clearInterval(timer);
	}, [interval]);
	return now;
}

/**
 * Focus and Escape for a renderer that shows the host's conversation in a
 * side panel. Focus moves with the panel: into its heading when a thread
 * opens from the interface, and back to whatever opened it when it closes,
 * so focus never falls to <body>. The opener is the `[data-thread-id]` row
 * under `openerScope` (a selector prefix), else `fallbackRef`. Escape closes
 * the panel unless a text field owns it.
 */
export function useThreadPanelFocus(
	port: InterfacePort,
	panelOpen: boolean,
	openerScope = ""
) {
	const rootRef = useRef<HTMLDivElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const fallbackRef = useRef<HTMLButtonElement>(null);
	const openerThreadRef = useRef<string | null>(null);
	const focusRequestRef = useRef<FocusRequest | null>(null);
	const wasOpenRef = useRef(panelOpen);

	const requestFocus = (to: FocusRequest["to"]) => {
		focusRequestRef.current = { at: Date.now(), to };
	};
	const openThread = (threadId: string) => {
		openerThreadRef.current = threadId;
		requestFocus("panel");
		port.openThread(threadId);
	};
	/** Starts a thread and focuses its panel; focus returns to `fallbackRef`. */
	const startThread = (input: Parameters<InterfacePort["startThread"]>[0]) => {
		openerThreadRef.current = null;
		requestFocus("panel");
		port.startThread(input);
	};
	const closePanel = () => {
		requestFocus("opener");
		port.closeThread();
	};

	useLayoutEffect(() => {
		const wasOpen = wasOpenRef.current;
		wasOpenRef.current = panelOpen;
		const request = focusRequestRef.current;
		const fresh =
			request !== null && Date.now() - request.at < FOCUS_REQUEST_TTL_MS;
		if (panelOpen && fresh && request.to === "panel") {
			focusRequestRef.current = null;
			headingRef.current?.focus();
			return;
		}
		if (!(wasOpen && !panelOpen)) {
			return;
		}
		focusRequestRef.current = null;
		const active = document.activeElement;
		const lost =
			active === null ||
			active === document.body ||
			!rootRef.current?.contains(active);
		if (!((fresh && request.to === "opener") || lost)) {
			return;
		}
		const threadId = openerThreadRef.current;
		const opener = threadId
			? rootRef.current?.querySelector<HTMLElement>(
					`${openerScope}[data-thread-id="${CSS.escape(threadId)}"]`
				)
			: null;
		(opener ?? fallbackRef.current)?.focus();
	}, [panelOpen, openerScope]);

	// Escape with focus nowhere (after clicking plain text) still closes.
	useEffect(() => {
		if (!panelOpen) {
			return;
		}
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isInterfaceCovered(rootRef.current)) {
				return;
			}
			if (
				event.key === "Escape" &&
				!event.defaultPrevented &&
				event.target === document.body
			) {
				event.preventDefault();
				focusRequestRef.current = { at: Date.now(), to: "opener" };
				port.closeThread();
			}
		};
		document.addEventListener("keydown", onDocumentKeyDown);
		return () => document.removeEventListener("keydown", onDocumentKeyDown);
	}, [panelOpen, port]);

	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key === "Escape" &&
			panelOpen &&
			!event.defaultPrevented &&
			!isEditable(event.target)
		) {
			event.preventDefault();
			closePanel();
		}
	};

	return {
		closePanel,
		fallbackRef,
		headingRef,
		onRootKeyDown,
		openThread,
		rootRef,
		startThread,
	};
}
