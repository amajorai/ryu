import { useCallback, useSyncExternalStore } from "react";

const TAB_VIEW_MODE_EVENT = "ryu:tab-view-mode-change";

export interface TabViewModeOptions<T extends string> {
	defaultMode: T;
	storageKey: string;
	tabKey: string;
	validModes: readonly T[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readStoredModes(storageKey: string): Record<string, string> | null {
	try {
		const raw = localStorage.getItem(storageKey);
		if (!raw) {
			return null;
		}
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) {
			return null;
		}
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string"
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
		return validModes.includes(candidate as T) ? (candidate as T) : defaultMode;
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
			if (typeof window === "undefined") {
				return () => undefined;
			}
			const handleChange = (event: Event) => {
				if (event.type === "storage") {
					const key = (event as StorageEvent).key;
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
