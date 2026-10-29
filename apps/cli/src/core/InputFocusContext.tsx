/* @jsxImportSource @opentui/react */
// InputFocusContext coordinates keyboard ownership between active surfaces and
// global overlays.
//
// Every mounted useKeyboard handler sees each key (OpenTUI has no bubbling or
// stopPropagation). Surfaces read useInputFocused() to yield keys while a text
// field, root modal, or the command palette owns the keyboard. Tabs call
// setInputFocused(true/false) as inputs and modals focus or blur; the shell
// reports command-palette visibility through setPaletteOpen() and sidebar
// keyboard focus mode (F6) through setSidebarFocused(); surfaces yield to both.
//
// Ctrl-modified globals (Ctrl+K palette, Ctrl+N node picker, Ctrl+C) are
// handled by the shell before the palette captures keys, matching apps/cli.
//
// Ctrl+C is layered: the shell copies a selection first, then offers the key to
// the active surface's interrupt handler (registered with useInterruptHandler)
// to stop a stream or clear a draft, and only then arms a two-press quit. The
// handler registry is ref-backed so registering never re-renders the tree.

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";

interface InputFocusContextValue {
	/** True while a tab/overlay owns raw character input. */
	inputFocused: boolean;
	/** True while the shell's node picker owns keyboard input. */
	nodePickerOpen: boolean;
	/** True while a shell overlay (OverlayHost) owns keyboard input. */
	overlayOpen: boolean;
	/** True while the global command palette owns raw keyboard input. */
	paletteOpen: boolean;
	/**
	 * Registers a Ctrl+C interrupt handler. It returns true when it consumed the
	 * key (stopped a stream, cleared a draft). Returns the unregister function.
	 */
	registerInterruptHandler: (handler: InterruptHandler) => () => void;
	/** Runs the most recently registered interrupt handler; true when handled. */
	runInterruptHandler: () => boolean;
	/** Records one owner's claim on raw character input; input stays claimed
	 * while any owner holds a claim. */
	setInputClaim: (owner: string, focused: boolean) => void;
	setNodePickerOpen: (open: boolean) => void;
	/** The overlay host reports whether an overlay is open. Kept apart from
	 * setInputFocused so closing an overlay never clears a surface's own claim. */
	setOverlayOpen: (open: boolean) => void;
	/** The shell reports command-palette visibility to active surfaces. */
	setPaletteOpen: (open: boolean) => void;
	/** The shell reports sidebar keyboard focus mode to active surfaces. */
	setSidebarFocused: (focused: boolean) => void;
	/** True while the sidebar's keyboard focus mode owns ↑/↓/Enter/Esc. */
	sidebarFocused: boolean;
}

/** A surface's Ctrl+C handler: true when it consumed the key. */
export type InterruptHandler = () => boolean;

const InputFocusContext = createContext<InputFocusContextValue | null>(null);

export function InputFocusProvider({ children }: { children: ReactNode }) {
	const [inputFocused, setInputFocusedState] = useState(false);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [nodePickerOpen, setNodePickerOpen] = useState(false);
	const [overlayOpen, setOverlayOpen] = useState(false);
	const [sidebarFocused, setSidebarFocused] = useState(false);
	// Claims are per owner, so one surface releasing (an unfocused split pane or
	// background tab running its effect after the focused one) never clears
	// another's claim. Equal state values bail out of re-rendering.
	const claimsRef = useRef(new Set<string>());
	const setInputClaim = useCallback((owner: string, focused: boolean) => {
		const claims = claimsRef.current;
		if (focused) {
			claims.add(owner);
		} else {
			claims.delete(owner);
		}
		setInputFocusedState(claims.size > 0);
	}, []);
	const interruptHandlers = useRef(new Set<InterruptHandler>());
	const registerInterruptHandler = useCallback((handler: InterruptHandler) => {
		interruptHandlers.current.add(handler);
		return () => {
			interruptHandlers.current.delete(handler);
		};
	}, []);
	const runInterruptHandler = useCallback(() => {
		let latest: InterruptHandler | undefined;
		for (const handler of interruptHandlers.current) {
			latest = handler;
		}
		return latest?.() ?? false;
	}, []);
	const value = useMemo<InputFocusContextValue>(
		() => ({
			inputFocused,
			paletteOpen,
			nodePickerOpen,
			overlayOpen,
			registerInterruptHandler,
			runInterruptHandler,
			setInputClaim,
			setPaletteOpen,
			setNodePickerOpen,
			setOverlayOpen,
			setSidebarFocused,
			sidebarFocused,
		}),
		[
			inputFocused,
			paletteOpen,
			nodePickerOpen,
			overlayOpen,
			sidebarFocused,
			registerInterruptHandler,
			runInterruptHandler,
			setInputClaim,
		]
	);
	return (
		<InputFocusContext.Provider value={value}>
			{children}
		</InputFocusContext.Provider>
	);
}

/** Read whether a text input, overlay, or command palette owns raw keyboard input. */
export function useInputFocused(): boolean {
	const ctx = useContext(InputFocusContext);
	return Boolean(
		ctx?.inputFocused ||
			ctx?.overlayOpen ||
			ctx?.paletteOpen ||
			ctx?.nodePickerOpen ||
			ctx?.sidebarFocused
	);
}

/** Active surfaces yield to any independent shell keyboard owner: the
 * palette, the node picker, or the sidebar's focus mode. */
export function useShellKeyboardCaptured(): boolean {
	const ctx = useContext(InputFocusContext);
	return Boolean(
		ctx?.paletteOpen || ctx?.nodePickerOpen || ctx?.sidebarFocused
	);
}

/** Read whether the sidebar's keyboard focus mode is active. */
export function useSidebarFocused(): boolean {
	return useContext(InputFocusContext)?.sidebarFocused ?? false;
}

/** The shell enters or leaves the sidebar's keyboard focus mode. */
export function useSetSidebarFocused(): (focused: boolean) => void {
	const ctx = useContext(InputFocusContext);
	if (!ctx) {
		throw new Error(
			"useSetSidebarFocused must be used within InputFocusProvider"
		);
	}
	return ctx.setSidebarFocused;
}

export function useSetNodePickerOpen(): (open: boolean) => void {
	const ctx = useContext(InputFocusContext);
	if (!ctx) {
		throw new Error(
			"useSetNodePickerOpen must be used within InputFocusProvider"
		);
	}
	return ctx.setNodePickerOpen;
}

/** The overlay host marks an overlay open so surfaces release keyboard input. */
export function useSetOverlayOpen(): (open: boolean) => void {
	const ctx = useContext(InputFocusContext);
	if (!ctx) {
		throw new Error("useSetOverlayOpen must be used within InputFocusProvider");
	}
	return ctx.setOverlayOpen;
}

/** Read whether the global command palette owns raw keyboard input. */
export function usePaletteOpen(): boolean {
	return useContext(InputFocusContext)?.paletteOpen ?? false;
}

/** The shell marks the command palette open so surfaces can release keyboard input. */
export function useSetPaletteOpen(): (open: boolean) => void {
	const ctx = useContext(InputFocusContext);
	if (!ctx) {
		throw new Error("useSetPaletteOpen must be used within InputFocusProvider");
	}
	return ctx.setPaletteOpen;
}

/** Get the setter a tab uses to claim/release raw character input. Each
 * calling component holds its own claim, so its false never clears another
 * component's true. */
export function useSetInputFocused(): (focused: boolean) => void {
	const ctx = useContext(InputFocusContext);
	const owner = useId();
	const setInputClaim = ctx?.setInputClaim;
	const setInputFocused = useCallback(
		(focused: boolean) => setInputClaim?.(owner, focused),
		[owner, setInputClaim]
	);
	if (!setInputClaim) {
		throw new Error(
			"useSetInputFocused must be used within InputFocusProvider"
		);
	}
	return setInputFocused;
}

/**
 * Offers the active surface a chance to consume Ctrl+C (stop a stream, clear a
 * draft) before the shell arms its two-press quit. Only register while the
 * surface owns the keyboard; the latest handler is read through a ref so a
 * changing callback never re-registers.
 */
export function useInterruptHandler(
	handler: InterruptHandler,
	enabled: boolean
): void {
	const ctx = useContext(InputFocusContext);
	const handlerRef = useRef(handler);
	handlerRef.current = handler;
	const register = ctx?.registerInterruptHandler;
	useEffect(() => {
		if (!(enabled && register)) {
			return;
		}
		return register(() => handlerRef.current());
	}, [enabled, register]);
}

/** The shell's entry point for offering Ctrl+C to the active surface. */
export function useRunInterruptHandler(): () => boolean {
	const ctx = useContext(InputFocusContext);
	if (!ctx) {
		throw new Error(
			"useRunInterruptHandler must be used within InputFocusProvider"
		);
	}
	return ctx.runInterruptHandler;
}
