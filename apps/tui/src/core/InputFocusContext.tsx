/* @jsxImportSource @opentui/react */
// InputFocusContext coordinates keyboard ownership between the shell and tabs.
//
// Every mounted useKeyboard handler fires on every key (OpenTUI has no event
// bubbling/stop), so the shell's plain-key globals (digit/letter tab jump, j/k
// nav, q quit) would steal characters the moment a tab focuses a text field. A
// tab that owns a focused <input>/<textarea> (or any modal capturing raw keys)
// calls setInputFocused(true) on focus and false on blur; the shell reads
// useInputFocused() and suppresses its plain-key globals while it is true.
//
// Ctrl-modified globals (Ctrl+P palette, Ctrl+N node picker, Ctrl+C quit) are
// NOT gated - they fire even mid-compose, matching apps/cli.

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";

interface InputFocusContextValue {
	/** True while a tab/overlay owns raw character input. */
	inputFocused: boolean;
	/** Tabs call this on focus(true)/blur(false) of a text field or key-capturing overlay. */
	setInputFocused: (focused: boolean) => void;
}

const InputFocusContext = createContext<InputFocusContextValue | null>(null);

export function InputFocusProvider({ children }: { children: ReactNode }) {
	const [inputFocused, setInputFocusedState] = useState(false);
	// Guard against redundant renders when many fields report the same state.
	const lastRef = useRef(false);
	const setInputFocused = useCallback((focused: boolean) => {
		if (lastRef.current === focused) {
			return;
		}
		lastRef.current = focused;
		setInputFocusedState(focused);
	}, []);
	const value = useMemo<InputFocusContextValue>(
		() => ({ inputFocused, setInputFocused }),
		[inputFocused, setInputFocused]
	);
	return (
		<InputFocusContext.Provider value={value}>
			{children}
		</InputFocusContext.Provider>
	);
}

/** Read whether a text input currently owns the keyboard. */
export function useInputFocused(): boolean {
	const ctx = useContext(InputFocusContext);
	return ctx?.inputFocused ?? false;
}

/** Get the setter a tab uses to claim/release raw character input. */
export function useSetInputFocused(): (focused: boolean) => void {
	const ctx = useContext(InputFocusContext);
	if (!ctx) {
		throw new Error(
			"useSetInputFocused must be used within InputFocusProvider"
		);
	}
	return ctx.setInputFocused;
}
