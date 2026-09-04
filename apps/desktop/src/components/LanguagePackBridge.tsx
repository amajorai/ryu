import {
	BUILT_IN_LANGUAGE_PACKS,
	LANGUAGE_PACKS_CHANGED_EVENT,
	type LanguagePack,
	validateLanguagePack,
} from "@ryu/i18n";
import { I18nProvider } from "@ryu/i18n/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import { fetchInstalledLanguagePacks } from "@/src/lib/api/language-packs.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

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

	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		const load = async () => {
			try {
				const next = await fetchInstalledLanguagePacks(
					target,
					controller.signal
				);
				if (!cancelled) {
					setPacks(next);
				}
			} catch {
				if (!cancelled) {
					setPacks([]);
				}
			}
		};
		void load();
		const onChanged = (event: Event) => {
			const detail =
				event instanceof CustomEvent && event.detail ? event.detail : null;
			if (detail) {
				try {
					const pack = validateLanguagePack(detail);
					setPacks((current) => [
						...current.filter((candidate) => candidate.id !== pack.id),
						{ ...pack, enabled: true },
					]);
					return;
				} catch {
					// Fall through to a fresh Core read for malformed event details.
				}
			}
			void load();
		};
		window.addEventListener(LANGUAGE_PACKS_CHANGED_EVENT, onChanged);
		return () => {
			cancelled = true;
			controller.abort();
			window.removeEventListener(LANGUAGE_PACKS_CHANGED_EVENT, onChanged);
		};
	}, [target]);

	return <I18nProvider packs={packs}>{children}</I18nProvider>;
}

export { BUILT_IN_LANGUAGE_PACKS };
