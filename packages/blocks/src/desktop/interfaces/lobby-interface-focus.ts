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
	isEditable,
} from "./lobby-interface-constants.ts";

/** Focus and Escape handling for the lobby's thread sheet. */
export function useLobbyThreadFocus({
	headingRef,
	panelOpen,
	port,
	rootRef,
}: {
	headingRef: RefObject<HTMLHeadingElement | null>;
	panelOpen: boolean;
	port: InterfacePort;
	rootRef: RefObject<HTMLDivElement | null>;
}) {
	const openerRef = useRef<HTMLElement | null>(null);
	const focusRequestRef = useRef<number | null>(null);
	const wasOpenRef = useRef(panelOpen);

	const rememberOpener = () => {
		const active = document.activeElement;
		openerRef.current =
			active instanceof HTMLElement && rootRef.current?.contains(active)
				? active
				: null;
		focusRequestRef.current = Date.now();
	};
	const closeThread = () => {
		port.closeThread();
	};

	// Focus follows the panel: into its heading when the lobby opened it, and
	// back to the control that opened it when it closes.
	useLayoutEffect(() => {
		const wasOpen = wasOpenRef.current;
		wasOpenRef.current = panelOpen;
		const requestedAt = focusRequestRef.current;
		const fresh =
			requestedAt !== null && Date.now() - requestedAt < FOCUS_REQUEST_TTL_MS;
		if (panelOpen && !wasOpen && fresh) {
			focusRequestRef.current = null;
			headingRef.current?.focus();
			return;
		}
		if (wasOpen && !panelOpen) {
			const active = document.activeElement;
			const lost =
				active === null ||
				active === document.body ||
				!rootRef.current?.contains(active);
			const opener = openerRef.current;
			if (lost && opener?.isConnected) {
				opener.focus();
			}
		}
	}, [panelOpen]);

	// Escape with focus nowhere (after clicking plain text) still closes.
	useEffect(() => {
		if (!panelOpen) {
			return;
		}
		const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
			if (
				event.key === "Escape" &&
				!event.defaultPrevented &&
				event.target === document.body &&
				!isInterfaceCovered(rootRef.current)
			) {
				event.preventDefault();
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
			closeThread();
		}
	};
	return { closeThread, onRootKeyDown, rememberOpener };
}
