/* @jsxImportSource @opentui/react */
// OverlayHost + OverlayProvider - the modal layer for the shell. One overlay is
// open at a time, keyed by id; the provider exposes openOverlay/closeOverlay and
// the current id, and the host renders the open overlay's registered body inside
// the shared Modal (dimmed backdrop, centred bordered panel, scrolling body).
//
// While an overlay is open it claims raw character input (InputFocusContext) so
// the shell suppresses its plain-key globals, and Esc closes it. Bodies own their
// own inner navigation/keyboard, gated on being open.

import { useKeyboard } from "@opentui/react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useSetOverlayOpen } from "../core/InputFocusContext.tsx";
import { Modal } from "../ui/Modal.tsx";
import { resolveOverlay } from "./registry.ts";

interface OverlayContextValue {
	/** Close whatever overlay is open (no-op if none). */
	closeOverlay: () => void;
	/** The open overlay id, or null. */
	openId: string | null;
	/** Open an overlay by id (registry id, e.g. "settings"). */
	openOverlay: (id: string) => void;
}

const PANEL_MAX_WIDTH = 120;

const OverlayContext = createContext<OverlayContextValue | null>(null);

export function OverlayProvider({ children }: { children: ReactNode }) {
	const [openId, setOpenId] = useState<string | null>(null);
	const openOverlay = useCallback((id: string) => setOpenId(id), []);
	const closeOverlay = useCallback(() => setOpenId(null), []);
	const value = useMemo<OverlayContextValue>(
		() => ({ openId, openOverlay, closeOverlay }),
		[openId, openOverlay, closeOverlay]
	);
	return (
		<OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>
	);
}

/** Read the overlay controls. Throws outside OverlayProvider. */
export function useOverlay(): OverlayContextValue {
	const ctx = useContext(OverlayContext);
	if (!ctx) {
		throw new Error("useOverlay must be used within an OverlayProvider");
	}
	return ctx;
}

/** The floating modal layer. Mount once near the root; renders nothing when no
 * overlay is open. */
export function OverlayHost() {
	const { openId, closeOverlay } = useOverlay();
	const setOverlayOpen = useSetOverlayOpen();

	// Claim raw input while open so shell plain-key globals stay quiet. This is
	// its own flag, so closing never clobbers a surface's setInputFocused claim.
	useEffect(() => {
		setOverlayOpen(openId !== null);
		return () => setOverlayOpen(false);
	}, [openId, setOverlayOpen]);

	useKeyboard((key) => {
		if (openId && key.name === "escape") {
			closeOverlay();
		}
	});

	if (!openId) {
		return null;
	}
	const overlay = resolveOverlay(openId);
	if (!overlay) {
		return null;
	}
	const Body = overlay.Body;
	return (
		<Modal
			onClose={closeOverlay}
			title={overlay.title}
			width={PANEL_MAX_WIDTH}
			zIndex={40}
		>
			<Body close={closeOverlay} id={openId} />
		</Modal>
	);
}
