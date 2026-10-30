"use client";

import { DitherGradient } from "@ryu/ui/components/dither-kit/gradient.tsx";
import { TabsContent } from "@ryu/ui/components/tabs.tsx";
import { DitherLayerControls } from "./glyph-picker-dither-controls.tsx";
import type { GlyphPickerState } from "./glyph-picker-state.ts";

export function GlyphPickerDitherTab({ state }: { state: GlyphPickerState }) {
	const { dither, setDither } = state;
	return (
		<TabsContent className="pt-3" value="dither">
			<div className="space-y-4">
				<div className="flex h-40 items-center justify-center rounded-lg bg-muted/30">
					<span className="relative block size-24 overflow-hidden rounded-full ring-1 ring-border">
						<DitherGradient
							direction={dither.direction}
							from={dither.from}
							to={dither.to ?? "transparent"}
						/>
					</span>
				</div>
				<DitherLayerControls
					dither={dither}
					enabled
					onChange={setDither}
					onEnabledChange={() => undefined}
					showToggle={false}
				/>
				<p className="text-muted-foreground text-xs">
					Tip: on the Icon or Emoji tabs you can also use dither as a background
					behind the glyph. DiceBear does not mix with dither.
				</p>
			</div>
		</TabsContent>
	);
}
