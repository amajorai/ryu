// Ref-callback hook that completes a settings-search jump.
//
// A search result click stores the target in `settings-focus` and switches the
// dialog's section. This hook runs with the content pane: once the pane's
// element is mounted it claims a pending reveal for its dialog and section and
// waits for the row to mount before scrolling to and flashing it. It claims one
// again for every later request aimed at the section already on screen, which
// changes no state that would re-run the claim on its own.

import { useEffect, useState } from "react";
import {
	consumeSettingReveal,
	peekSettingReveal,
	revealSettingWhenReady,
	subscribeSettingReveal,
} from "@/src/lib/settings-focus.ts";
import type { SettingsDialogId } from "@/src/lib/settings-index.ts";

/**
 * Returns a ref callback to put on the settings content container. Scoping the
 * search to that container (rather than `document`) keeps a row title in the
 * SIDEBAR from winning over the identically-named row in the pane.
 *
 * Nothing is claimed until the container is mounted, so a dialog that is
 * closed (or whose content portal has not rendered yet) never takes a request
 * meant for the pane that will show it, and `dialog` keeps the two settings
 * dialogs from taking each other's request for a section id they share.
 */
export function useSettingReveal(
	section: string,
	dialog: SettingsDialogId
): (element: HTMLDivElement | null) => void {
	const [root, setRoot] = useState<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!root) {
			return;
		}
		let cancelReveal: (() => void) | undefined;
		const claim = () => {
			if (peekSettingReveal(section)?.dialog !== dialog) {
				return;
			}
			const entry = consumeSettingReveal(section);
			if (!entry) {
				return;
			}
			cancelReveal?.();
			cancelReveal = revealSettingWhenReady(entry, root);
		};
		// The request that brought this section up was made before it rendered.
		claim();
		const unsubscribe = subscribeSettingReveal((entry) => {
			if (entry.section === section && entry.dialog === dialog) {
				claim();
			}
		});
		return () => {
			unsubscribe();
			cancelReveal?.();
		};
	}, [dialog, root, section]);
	return setRoot;
}
