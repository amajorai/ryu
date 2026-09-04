import type { LanguagePack } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import { useEffect, useState } from "react";

/** The Island is a separate Electron renderer, so it needs its own provider
 * and a main-process catalog read rather than inheriting Desktop's context. */
export function IslandI18nProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [packs, setPacks] = useState<LanguagePack[]>([]);

	useEffect(() => {
		let cancelled = false;
		const refresh = () => {
			void window.island.languagePacks
				.get()
				.then((result) => {
					if (!cancelled && result.available) {
						setPacks(result.packs);
					}
				})
				.catch(() => undefined);
		};
		refresh();
		window.addEventListener("focus", refresh);
		const interval = window.setInterval(refresh, 30_000);
		return () => {
			cancelled = true;
			window.removeEventListener("focus", refresh);
			window.clearInterval(interval);
		};
	}, []);

	return <I18nProvider packs={packs}>{children}</I18nProvider>;
}
