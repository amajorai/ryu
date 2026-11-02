import type { InterfacePort } from "@ryuhq/protocol/interfaces";
import {
	type KeyboardEvent,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { isInterfaceCovered } from "./interface-keys.ts";
import {
	FOCUS_REQUEST_TTL_MS,
	type FocusRequest,
	isEditable,
	STOP_SELECTOR,
} from "./path-interface-nav.tsx";
import type { PathUnit } from "./path-model.ts";

interface PathPanelFocusInput {
	activeThreadId: string | null;
	headingRef: RefObject<HTMLHeadingElement | null>;
	panelOpen: boolean;
	port: InterfacePort;
	rootRef: RefObject<HTMLDivElement | null>;
}

/**
 * The path's thread panel and focus: opening a stop moves focus into the
 * panel's heading, and closing it (button, Escape) returns focus to that stop.
 */
export function usePathPanelFocus({
	activeThreadId,
	headingRef,
	panelOpen,
	port,
	rootRef,
}: PathPanelFocusInput) {
	const openerRef = useRef<string | null>(null);
	const focusRequestRef = useRef<FocusRequest | null>(null);
	const wasOpenRef = useRef(panelOpen);
	// The last thread the panel showed, so closing returns focus to its stop
	// even when the host opened it (a deep link) rather than a click here.
	const lastThreadRef = useRef<string | null>(activeThreadId);
	useEffect(() => {
		if (activeThreadId) {
			lastThreadRef.current = activeThreadId;
		}
	}, [activeThreadId]);

	const requestFocus = (to: FocusRequest["to"]) => {
		focusRequestRef.current = { at: Date.now(), to };
	};
	const openStop = (threadId: string) => {
		openerRef.current = threadId;
		requestFocus("panel");
		port.openThread(threadId);
	};
	const startIn = (unit: PathUnit) => {
		openerRef.current = null;
		requestFocus("panel");
		port.startThread(unit.start);
	};
	const startNew = () => {
		openerRef.current = null;
		requestFocus("panel");
		port.startThread({});
	};
	const closePanel = () => {
		requestFocus("opener");
		port.closeThread();
	};

	// Move focus with the panel: into its heading when a stop opens it, and
	// back to that stop when it closes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable; only the panel's open state drives focus.
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
		const threadId = openerRef.current ?? lastThreadRef.current;
		const root = rootRef.current;
		const fromStop = threadId
			? root?.querySelector<HTMLElement>(
					`[data-thread-id="${CSS.escape(threadId)}"]`
				)
			: null;
		(
			fromStop ??
			root?.querySelector<HTMLElement>(`${STOP_SELECTOR}[tabindex="0"]`) ??
			root?.querySelector<HTMLElement>(STOP_SELECTOR)
		)?.focus();
	}, [panelOpen]);

	// Escape with focus nowhere (after clicking plain text) still closes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the root ref is stable.
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

	return { closePanel, onRootKeyDown, openStop, startIn, startNew };
}
