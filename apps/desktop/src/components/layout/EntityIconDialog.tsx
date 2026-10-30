// Thin host around the shared GlyphPicker for spaces, pages, and other
// server-persisted entities (`allowed="entity"`).
//
// The picker (emoji-mart, colour picker, icon search) loads the first time a
// dialog opens and stays mounted afterwards so later opens and the close
// animation behave exactly as before. The sidebar renders one of these per
// space row, so a static import would put the picker on the startup path.

import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { lazy, Suspense, useState } from "react";

const GlyphPicker = lazy(() =>
	import("@ryu/ui/components/glyph-picker.tsx").then((module) => ({
		default: module.GlyphPicker,
	}))
);

/** Controlled GlyphPicker for a space / page / meeting-style entity icon. */
export function EntityIconDialog({
	title,
	description,
	value,
	open,
	onOpenChange,
	onChange,
}: {
	description?: string;
	onChange: (next: GlyphValue) => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	title: string;
	value: GlyphValue;
}) {
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
				description={description}
				onChange={(next) => {
					onChange(next);
					onOpenChange(false);
				}}
				onOpenChange={onOpenChange}
				open={open}
				title={title}
				value={value}
			/>
		</Suspense>
	);
}
