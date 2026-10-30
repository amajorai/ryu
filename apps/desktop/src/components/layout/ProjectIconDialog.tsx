// Project folder glyph editor — thin host around the shared GlyphPicker
// (`allowed="entity"`: avatar · icon · emoji · dicebear). Stored in the
// workspace store (localStorage), keyed by folder path.

import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
	type ProjectIcon,
	useWorkspaceStore,
} from "@/src/store/useWorkspaceStore.ts";

// The picker loads the first time the dialog opens (see EntityIconDialog).
const GlyphPicker = lazy(() =>
	import("@ryu/ui/components/glyph-picker.tsx").then((module) => ({
		default: module.GlyphPicker,
	}))
);

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
	const { projectIcons, setProjectIcon, clearProjectIcon } = useWorkspaceStore(
		useShallow((s) => ({
			projectIcons: s.projectIcons,
			setProjectIcon: s.setProjectIcon,
			clearProjectIcon: s.clearProjectIcon,
		}))
	);
	const current = projectIcons[path] ?? null;
	const [opened, setOpened] = useState(open);
	if (open && !opened) {
		setOpened(true);
	}
	if (!opened) {
		return null;
	}

	return (
		<Suspense fallback={null}>
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
		</Suspense>
	);
}
