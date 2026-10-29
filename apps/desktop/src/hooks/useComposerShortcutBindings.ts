// Resolved composer cycle bindings from the live hotkey registry.
//
// The four composer actions live in DESKTOP_HOTKEYS and are edited in
// Settings → Keyboard shortcuts. Consumers pass the resolved map into
// `handleComposerSettingsShortcut` so Tab / Shift+Tab / etc. stay focus-scoped
// inside the prompt input (never registered as window-level useHotkey handlers).

import {
	type ComposerShortcutBindings,
	composerBindingsFromMap,
} from "@ryu/blocks/composer/composer-shortcuts.ts";
import { useHotkeysAdmin } from "@ryu/hotkeys/react";
import { useMemo } from "react";

/** Effective composer shortcut bindings (defaults + user overrides). */
export function useComposerShortcutBindings(): ComposerShortcutBindings {
	const { bindings } = useHotkeysAdmin();
	return useMemo(() => composerBindingsFromMap(bindings), [bindings]);
}
