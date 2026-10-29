// Project folder glyph editor — thin host around the shared GlyphPicker
// (`allowed="entity"`: avatar · icon · emoji · dicebear). Stored in the
// workspace store (localStorage), keyed by folder path.

import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { GlyphPicker } from "@ryu/ui/components/glyph-picker.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import {
	type ProjectIcon,
	useWorkspaceStore,
} from "@/src/store/useWorkspaceStore.ts";

/**
 * Render a project's glyph: its custom emoji/image/icon/dicebear if set,
 * otherwise `fallback` (typically the default folder Hugeicon).
 */
export function ProjectGlyph({
	icon,
	fallback,
	size = 14,
	className,
}: {
	className?: string;
	fallback: ReactNode;
	icon: ProjectIcon | undefined;
	size?: number;
}) {
	return (
		<GlyphDisplay
			className={cn("", className)}
			corners="compact"
			fallback={fallback}
			size={size}
			value={icon ?? null}
		/>
	);
}

/** GlyphPicker editor for a single project folder. Controlled by the caller
 *  (opened from the sidebar's right-click "Change icon…" item). */
export function ProjectIconDialog({
	path,
	name,
	open,
	onOpenChange,
}: {
	name: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	path: string;
}) {
	const { projectIcons, setProjectIcon, clearProjectIcon } =
		useWorkspaceStore();
	const current = projectIcons[path] ?? null;

	return (
		<GlyphPicker
			allowed="entity"
			description={name}
			onChange={(next: GlyphValue) => {
				if (next) {
					setProjectIcon(path, next);
				} else {
					clearProjectIcon(path);
				}
				onOpenChange(false);
			}}
			onOpenChange={onOpenChange}
			open={open}
			title="Project icon"
			value={current}
		/>
	);
}
