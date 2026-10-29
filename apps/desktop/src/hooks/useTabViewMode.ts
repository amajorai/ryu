import { useCallback, useSyncExternalStore } from "react";
import { z } from "zod";

const TAB_VIEW_MODE_EVENT = "ryu:tab-view-mode-change";
const storageEventSchema = z.object({ key: z.string().nullable() });

export interface TabViewModeOptions<T extends string> {
	defaultMode: T;
	storageKey: string;
	tabKey: string;
	validModes: readonly T[];
}

const storedModeValueSchema = z.string().optional().catch(undefined);
const storedModesSchema = z.union([
	z.record(z.string(), storedModeValueSchema),
	z.array(storedModeValueSchema),
]);

function readStoredModes(storageKey: string): Record<string, string> | null {
	try {
		const raw = localStorage.getItem(storageKey);
		if (!raw) {
			return null;
		}
		const parsed = storedModesSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			return null;
		}
		return Object.fromEntries(
			Object.entries(parsed.data).filter(
				(entry): entry is [string, string] => entry[1] !== undefined
			)
		);
	} catch {
		return null;
	}
}

export function readTabViewMode<T extends string>({
	defaultMode,
	storageKey,
	tabKey,
	validModes,
}: TabViewModeOptions<T>): T {
	try {
		const raw = localStorage.getItem(storageKey);
		const modes = readStoredModes(storageKey);
		// Before per-tab preferences existed, this key held one plain mode. Treat it
		// as a migration fallback so existing users keep their explicit choice.
		const candidate = modes?.[tabKey] ?? (modes === null ? raw : null);
		return validModes.find((mode) => mode === candidate) ?? defaultMode;
	} catch {
		return defaultMode;
	}
}

export function writeTabViewMode<T extends string>(
	storageKey: string,
	tabKey: string,
	mode: T
): void {
	try {
		const current = readStoredModes(storageKey) ?? {};
		localStorage.setItem(
			storageKey,
			JSON.stringify({ ...current, [tabKey]: mode })
		);
		window.dispatchEvent(new Event(TAB_VIEW_MODE_EVENT));
	} catch {
		// View preferences are best-effort and must not block the surface.
	}
}

export function useTabViewMode<T extends string>({
	defaultMode,
	storageKey,
	tabKey,
	validModes,
}: TabViewModeOptions<T>): [T, (mode: T) => void] {
	const getSnapshot = useCallback(
		() =>
			readTabViewMode({
				defaultMode,
				storageKey,
				tabKey,
				validModes,
			}),
		[defaultMode, storageKey, tabKey, validModes]
	);
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (!globalThis.window) {
				return () => undefined;
			}
			const handleChange = (event: Event) => {
				if (event.type === "storage") {
					const parsed = storageEventSchema.safeParse(event);
					if (!parsed.success) {
						return;
					}
					const key = parsed.data.key;
					if (key !== null && key !== storageKey) {
						return;
					}
				}
				onChange();
			};
			window.addEventListener("storage", handleChange);
			window.addEventListener(TAB_VIEW_MODE_EVENT, handleChange);
			return () => {
				window.removeEventListener("storage", handleChange);
				window.removeEventListener(TAB_VIEW_MODE_EVENT, handleChange);
			};
		},
		[storageKey]
	);
	const mode = useSyncExternalStore(subscribe, getSnapshot, () => defaultMode);
	const setMode = useCallback(
		(next: T) => {
			if (!validModes.includes(next)) {
				return;
			}
			writeTabViewMode(storageKey, tabKey, next);
		},
		[storageKey, tabKey, validModes]
	);

	return [mode, setMode];
}
