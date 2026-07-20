// React bindings for Ryu's unified hotkey system.
//
// `HotkeysProvider` runs ONE window keydown listener for the whole surface and
// dispatches to the handler registered for the matching action id. Components
// bind behaviour with `useHotkey("command-palette.toggle", fn)` and never touch
// key strings — the chord is resolved from the registry + the user's overrides,
// so a rebind in settings retargets every consumer live. `useHotkeysAdmin`
// powers the settings table (rebind / clear / reset / reset-all + conflicts).

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type Chord,
	chordHasModifier,
	eventToChord,
	isEditableTarget,
	normalizeChord,
} from "./chord.ts";
import {
	findConflicts,
	type HotkeyRegistry,
	type Overrides,
	resolveAllBindings,
} from "./registry.ts";

/** Persistence for the user's overrides. Transport-agnostic on purpose. */
export interface HotkeyStorage {
	/** Load the saved overrides (empty object when none). */
	load(): Promise<Overrides>;
	/** Persist the full overrides map. */
	save(overrides: Overrides): Promise<void>;
	/** Optional: notify when overrides change elsewhere (other window/process). */
	subscribe?(onChange: (overrides: Overrides) => void): () => void;
}

interface HandlerEntry {
	/** Fire even when the event targets an editable element. */
	allowInInput: boolean;
	enabled: boolean;
	handler: (e: KeyboardEvent) => void;
}

interface HotkeysContextValue {
	bindings: Map<string, Chord | null>;
	conflicts: Map<Chord, string[]>;
	loading: boolean;
	overrides: Overrides;
	registerHandler: (id: string, entry: HandlerEntry) => () => void;
	registry: HotkeyRegistry;
	reset: (id: string) => void;
	resetAll: () => void;
	setOverride: (id: string, chord: Chord | null) => void;
}

const HotkeysContext = createContext<HotkeysContextValue | null>(null);

interface HotkeysProviderProps {
	children: ReactNode;
	registry: HotkeyRegistry;
	storage?: HotkeyStorage;
}

/** Provider that owns overrides, persistence, and the single keydown listener. */
export function HotkeysProvider({
	registry,
	storage,
	children,
}: HotkeysProviderProps) {
	const [overrides, setOverrides] = useState<Overrides>({});
	const [loading, setLoading] = useState<boolean>(Boolean(storage));

	const bindings = useMemo(
		() => resolveAllBindings(registry, overrides),
		[registry, overrides]
	);
	const conflicts = useMemo(
		() => findConflicts(registry, overrides),
		[registry, overrides]
	);

	// A chord -> actionId lookup for O(1) dispatch, skipping global (native) and
	// unbound actions.
	const chordToId = useMemo(() => {
		const map = new Map<Chord, string>();
		for (const action of registry) {
			if (action.global) {
				continue;
			}
			const chord = bindings.get(action.id);
			if (chord) {
				map.set(normalizeChord(chord), action.id);
			}
		}
		return map;
	}, [registry, bindings]);

	const handlersRef = useRef<Map<string, HandlerEntry>>(new Map());
	const chordToIdRef = useRef(chordToId);
	chordToIdRef.current = chordToId;

	// Load persisted overrides once, then subscribe to out-of-process changes.
	useEffect(() => {
		if (!storage) {
			return;
		}
		let active = true;
		storage
			.load()
			.then((loaded) => {
				if (active) {
					setOverrides(loaded);
				}
			})
			.catch(() => {
				// Persistence is best-effort; fall back to defaults.
			})
			.finally(() => {
				if (active) {
					setLoading(false);
				}
			});
		const unsubscribe = storage.subscribe?.((next) => {
			if (active) {
				setOverrides(next);
			}
		});
		return () => {
			active = false;
			unsubscribe?.();
		};
	}, [storage]);

	// Persist and apply a new overrides map.
	const commit = useCallback(
		(next: Overrides) => {
			setOverrides(next);
			storage?.save(next).catch(() => {
				// Best-effort; the in-memory state still reflects the change.
			});
		},
		[storage]
	);

	const setOverride = useCallback(
		(id: string, chord: Chord | null) => {
			commit({ ...overrides, [id]: chord });
		},
		[commit, overrides]
	);

	const reset = useCallback(
		(id: string) => {
			if (!Object.hasOwn(overrides, id)) {
				return;
			}
			const next = { ...overrides };
			delete next[id];
			commit(next);
		},
		[commit, overrides]
	);

	const resetAll = useCallback(() => {
		commit({});
	}, [commit]);

	const registerHandler = useCallback((id: string, entry: HandlerEntry) => {
		handlersRef.current.set(id, entry);
		return () => {
			handlersRef.current.delete(id);
		};
	}, []);

	// The single dispatch listener. Reads from refs so it never re-subscribes.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			const eventChord = eventToChord(e);
			if (eventChord === null) {
				return;
			}
			const id = chordToIdRef.current.get(normalizeChord(eventChord));
			if (!id) {
				return;
			}
			const entry = handlersRef.current.get(id);
			if (!entry?.enabled) {
				return;
			}
			// A modifier-bearing chord is safe inside inputs; a bare-key binding is
			// suppressed while typing unless the consumer opted in.
			if (
				!(entry.allowInInput || chordHasModifier(eventChord)) &&
				isEditableTarget(e.target)
			) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			entry.handler(e);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const value = useMemo<HotkeysContextValue>(
		() => ({
			registry,
			bindings,
			overrides,
			conflicts,
			loading,
			setOverride,
			reset,
			resetAll,
			registerHandler,
		}),
		[
			registry,
			bindings,
			overrides,
			conflicts,
			loading,
			setOverride,
			reset,
			resetAll,
			registerHandler,
		]
	);

	return (
		<HotkeysContext.Provider value={value}>{children}</HotkeysContext.Provider>
	);
}

function useHotkeysContext(): HotkeysContextValue {
	const ctx = useContext(HotkeysContext);
	if (!ctx) {
		throw new Error("useHotkey must be used within a HotkeysProvider");
	}
	return ctx;
}

/** Options for {@link useHotkey}. */
export interface UseHotkeyOptions {
	/** Fire even when focus is in an editable element (default: modifier chords only). */
	allowInInput?: boolean;
	/** When false the binding is inert (default true). */
	enabled?: boolean;
}

/**
 * Bind a handler to a registered action id. The chord is resolved from the
 * registry + user overrides, so rebinding in settings retargets this handler
 * with no code change. A no-op when the action is unbound (cleared).
 */
export function useHotkey(
	id: string,
	handler: (e: KeyboardEvent) => void,
	options?: UseHotkeyOptions
): void {
	const { registerHandler, bindings } = useHotkeysContext();
	const handlerRef = useRef(handler);
	handlerRef.current = handler;

	const enabled = options?.enabled ?? true;
	const binding = bindings.get(id) ?? null;
	const allowInInput =
		options?.allowInInput ?? (binding ? chordHasModifier(binding) : true);

	useEffect(() => {
		return registerHandler(id, {
			handler: (e) => handlerRef.current(e),
			enabled,
			allowInInput,
		});
	}, [id, enabled, allowInInput, registerHandler]);
}

/** Admin surface for the settings table: read + mutate all bindings. */
export interface HotkeysAdmin {
	bindings: Map<string, Chord | null>;
	conflicts: Map<Chord, string[]>;
	loading: boolean;
	overrides: Overrides;
	registry: HotkeyRegistry;
	/** Revert an action to its registry default. */
	reset: (id: string) => void;
	/** Revert every action to its registry default. */
	resetAll: () => void;
	/** Rebind (`chord`) or clear (`null`) an action. */
	setOverride: (id: string, chord: Chord | null) => void;
}

/** Access the full hotkey state for a settings editor. */
export function useHotkeysAdmin(): HotkeysAdmin {
	const ctx = useHotkeysContext();
	return {
		registry: ctx.registry,
		bindings: ctx.bindings,
		overrides: ctx.overrides,
		conflicts: ctx.conflicts,
		loading: ctx.loading,
		setOverride: ctx.setOverride,
		reset: ctx.reset,
		resetAll: ctx.resetAll,
	};
}
