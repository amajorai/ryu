// A browser's "open downloads" shortcut drawn as keycaps. Shared by the
// post-download guide and the /download page, so both print it the same way.
// No CSS module here: the page imports it without pulling in the guide's
// animations.

import { Kbd, KbdGroup } from "@ryu/ui/components/kbd.tsx";

const MODIFIER_GLYPHS = new Set(["⌘", "⌥", "⇧", "⌃"]);

/**
 * The keys of a shortcut as the guide prints them: `Ctrl+Shift+Y` splits on
 * `+`, and macOS glyph runs (`⌥⌘L`) split into one key per glyph.
 */
export function shortcutKeys(shortcut: string): string[] {
	if (shortcut.includes("+")) {
		return shortcut
			.split("+")
			.map((key) => key.trim())
			.filter(Boolean);
	}
	const keys: string[] = [];
	let rest = "";
	for (const character of shortcut) {
		if (MODIFIER_GLYPHS.has(character)) {
			keys.push(character);
		} else {
			rest += character;
		}
	}
	if (rest) {
		keys.push(rest);
	}
	return keys;
}

/**
 * Keycaps for a shortcut. Screen readers get the shortcut once as text; the
 * keycaps are hidden from them (a role-less `<kbd>` can't carry a label).
 */
export function ShortcutKeys({ shortcut }: { shortcut: string }) {
	return (
		<span className="inline-flex" data-testid="download-shortcut">
			<span className="sr-only">{shortcut}</span>
			<KbdGroup aria-hidden="true">
				{shortcutKeys(shortcut).map((key) => (
					<Kbd
						className="h-6 min-w-6 border border-border/70 bg-background font-mono text-foreground shadow-[0_1px_0_var(--border)]"
						key={key}
					>
						{key}
					</Kbd>
				))}
			</KbdGroup>
		</span>
	);
}
