/* @jsxImportSource @opentui/react */
// OverlayHost + OverlayProvider - the modal layer for the shell. One overlay is
// open at a time, keyed by id; the provider exposes openOverlay/closeOverlay and
// the current id, and the host renders the open overlay's registered body inside
// a centered, bordered panel with a title bar.
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
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useSetInputFocused } from "../core/InputFocusContext.tsx";
import { resolveOverlay } from "./registry.ts";

interface OverlayContextValue {
	/** Close whatever overlay is open (no-op if none). */
	closeOverlay: () => void;
	/** The open overlay id, or null. */
	openId: string | null;
	/** Open an overlay by id (registry id, e.g. "settings"). */
	openOverlay: (id: string) => void;
}

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
	const theme = useTheme();
	const setInputFocused = useSetInputFocused();

	// Claim raw input while open so shell plain-key globals stay quiet.
	useEffect(() => {
		setInputFocused(openId !== null);
		return () => setInputFocused(false);
	}, [openId, setInputFocused]);

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
		<box
			alignItems="center"
			height="100%"
			justifyContent="center"
			position="absolute"
			width="100%"
		>
			<box
				backgroundColor={theme.colors.background}
				borderColor={theme.colors.focusRing}
				borderStyle="rounded"
				flexDirection="column"
				minWidth={48}
				padding={1}
			>
				<box
					borderColor={theme.colors.border}
					borderStyle="single"
					flexDirection="row"
					justifyContent="space-between"
					paddingLeft={1}
					paddingRight={1}
				>
					<text fg={theme.colors.primary}>
						<b>{overlay.title}</b>
					</text>
					<text fg={theme.colors.mutedForeground}>Esc close</text>
				</box>
				<box flexDirection="column" paddingTop={1}>
					<Body close={closeOverlay} id={openId} />
				</box>
			</box>
		</box>
	);
}
