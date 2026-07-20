// Desktop-parity composer shortcuts (Tab / Shift+Tab / Shift+M / Shift+T), active
// only while island voice mode is open — not on the typed chat composer.

import type { ComposerSettingsSection } from "@ryu/blocks/composer/composer-settings-menu";
import { handleComposerSettingsShortcut } from "@ryu/blocks/composer/composer-shortcuts";
import { useEffect, useRef } from "react";

export function useVoiceModeShortcuts(
	active: boolean,
	sections: ComposerSettingsSection[]
): void {
	const sectionsRef = useRef(sections);
	sectionsRef.current = sections;

	useEffect(() => {
		if (!active) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent): void => {
			handleComposerSettingsShortcut(event, sectionsRef.current);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [active]);
}
