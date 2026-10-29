// apps/desktop/src/components/downloads/kindIcons.ts
//
// One glyph per artifact family, shared by the download rows and the
// available-updates rows so the same kind never wears two different icons
// across the tray. Keyed loosely (string) because Core's `DownloadKind` and the
// desktop's `UpdateKind` overlap but are not identical — `other` is the
// fallback for anything unmapped.

import {
	AudioWave01Icon,
	BrainIcon,
	Image02Icon,
	LayerIcon,
	Package01Icon,
	PlugSocketIcon,
	PotionIcon,
	Target01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

export const KIND_ICON = new Map<string, IconSvgElement>(
	Object.entries({
		agent: Target01Icon,
		app: Package01Icon,
		embedding: BrainIcon,
		engine: LayerIcon,
		mcp: PlugSocketIcon,
		media: Image02Icon,
		model: BrainIcon,
		other: Package01Icon,
		plugin: PlugSocketIcon,
		skill: PotionIcon,
		tool: Wrench01Icon,
		voice: AudioWave01Icon,
	})
);

/** The glyph for a kind, falling back to the generic package. */
export function kindIcon(kind: string): IconSvgElement {
	return KIND_ICON.get(kind) ?? Package01Icon;
}
