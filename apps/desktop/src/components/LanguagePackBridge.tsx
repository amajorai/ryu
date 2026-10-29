import "@ryu/i18n/official-catalog";
import {
	BUILT_IN_LANGUAGE_PACKS,
	LANGUAGE_PACK_STORAGE_KEY,
	LANGUAGE_PACKS_CHANGED_EVENT,
	type LanguagePack,
} from "@ryu/i18n";
import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
	LANGUAGE_MODE_KEY,
	useLanguageMode,
} from "@/src/hooks/useLanguageMode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { fetchInstalledLanguagePacks } from "@/src/lib/api/language-packs.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/**
 * This window's pack choice while local storage refuses to save it. A mode change
 * rebuilds the runtime, which would otherwise restore the older durable pack and
 * drop the explicit choice. `undefined` means durable storage is authoritative.
 */
let unsavedPackChoice: string | null | undefined;

/**
 * Whether a storage event discarded an unsaved choice. Every mounted Bridge
 * handles the same event; the first clears the shared choice, so the others
 * read this record instead of a value that is already cleared.
 */
const discardedUnsavedChoice = new WeakMap<StorageEvent, boolean>();

function persistPackChoice(id: string | null): void {
	try {
		if (id) {
			localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, id);
		} else {
			localStorage.removeItem(LANGUAGE_PACK_STORAGE_KEY);
		}
		unsavedPackChoice = undefined;
	} catch {
		// Persistence is best effort; the current session keeps the choice.
		unsavedPackChoice = id;
	}
}

/**
 * Loads Core-installed packs for both the native Tauri app and the browser-hosted
 * webapp. The built-in flavor pack is always present, so an offline/unavailable
 * node never blanks the UI or removes the default fallback catalog.
 */
export function LanguagePackBridge({ children }: { children: ReactNode }) {
	const node = useNodeStore((state) => state.getActiveNode());
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const [packs, setPacks] = useState<LanguagePack[]>([]);
	const [languageMode] = useLanguageMode();
	const [selectionVersion, setSelectionVersion] = useState(0);
	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (!(event.storageArea === null || event.storageArea === localStorage)) {
				return;
			}
			const packChanged =
				event.key === null || event.key === LANGUAGE_PACK_STORAGE_KEY;
			const modeChanged = event.key === LANGUAGE_MODE_KEY;
			if (!(packChanged || modeChanged)) {
				return;
			}
			let discardsUnsaved = discardedUnsavedChoice.get(event);
			if (discardsUnsaved === undefined) {
				discardsUnsaved = unsavedPackChoice !== undefined;
				discardedUnsavedChoice.set(event, discardsUnsaved);
			}
			// Another window's saved language choice supersedes an unsaved one.
			unsavedPackChoice = undefined;
			// A saved mode can equal this window's session mode, which re-renders
			// nothing, so rebuild whenever that save discards an unsaved pack.
			if (packChanged || discardsUnsaved) {
				setSelectionVersion((version) => version + 1);
			}
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		let requestVersion = 0;
		setPacks([]);
		const load = async () => {
			const version = ++requestVersion;
			try {
				const next = await fetchInstalledLanguagePacks(
					target,
					controller.signal
				);
				if (!cancelled && version === requestVersion) {
					setPacks(next);
				}
			} catch {
				if (!cancelled && version === requestVersion) {
					setPacks([]);
				}
			}
		};
		void load();
		const onChanged = () => {
			// Events invalidate the projection; Core owns enabled state and catalog data.
			void load();
		};
		window.addEventListener(LANGUAGE_PACKS_CHANGED_EVENT, onChanged);
		return () => {
			cancelled = true;
			controller.abort();
			window.removeEventListener(LANGUAGE_PACKS_CHANGED_EVENT, onChanged);
		};
	}, [target]);

	return (
		<I18nProvider
			initialLocale={languageMode === "auto" ? navigator.language : null}
			initialPackId={languageMode === "auto" ? null : unsavedPackChoice}
			packs={packs}
			persistPackId={persistPackChoice}
			selectionKey={`${languageMode}-${selectionVersion}`}
		>
			<I18nDirectionProvider>{children}</I18nDirectionProvider>
		</I18nProvider>
	);
}

export { BUILT_IN_LANGUAGE_PACKS };
