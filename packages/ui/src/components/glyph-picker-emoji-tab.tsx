"use client";

import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { TabsContent } from "@ryu/ui/components/tabs.tsx";
import type { EmojiSelectPayload } from "./glyph-picker-constants.ts";
import { DitherLayerControls } from "./glyph-picker-dither-controls.tsx";
import type { GlyphPickerState } from "./glyph-picker-state.ts";

export function GlyphPickerEmojiTab({ state }: { state: GlyphPickerState }) {
	const { ditherAsBg, setDitherAsBg, dither, setDither, applyEmoji } = state;
	return (
		<TabsContent className="pt-3" value="emoji">
			<div className="space-y-3">
				{ditherAsBg ? (
					<div className="flex h-20 items-center justify-center rounded-lg bg-muted/30">
						<GlyphDisplay
							alt=""
							className="rounded-lg"
							size={56}
							value={{
								kind: "emoji",
								emoji: "✨",
								dither,
							}}
						/>
					</div>
				) : null}
				<DitherLayerControls
					dither={dither}
					enabled={ditherAsBg}
					onChange={setDither}
					onEnabledChange={setDitherAsBg}
					showToggle
				/>
				<div className="overflow-hidden rounded-lg border border-border [&_em-emoji-picker]:w-full!">
					<Picker
						data={data}
						dynamicWidth
						emojiButtonSize={32}
						emojiSize={20}
						maxFrequentRows={1}
						navPosition="bottom"
						onEmojiSelect={(emoji: EmojiSelectPayload) => {
							if (emoji.native) {
								applyEmoji(emoji.native);
							}
						}}
						previewPosition="none"
						skinTonePosition="search"
						theme="auto"
					/>
				</div>
			</div>
		</TabsContent>
	);
}
