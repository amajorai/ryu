"use client";

import { GLYPH_ICON_COLORS } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { TabsContent } from "@ryu/ui/components/tabs.tsx";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Search } from "lucide-react";
import styles from "./glyph-picker.module.css";
import type { GlyphPickerDrawingStyle } from "./glyph-picker-constants.ts";
import { DitherLayerControls } from "./glyph-picker-dither-controls.tsx";
import type { GlyphPickerState } from "./glyph-picker-state.ts";

export function GlyphPickerIconTab({ state }: { state: GlyphPickerState }) {
	const {
		iconDraft,
		setIconDraft,
		iconColor,
		setIconColor,
		ditherAsBg,
		setDitherAsBg,
		dither,
		setDither,
		iconQuery,
		setIconQuery,
		iconLoading,
		iconError,
		iconHits,
	} = state;
	return (
		<TabsContent className="pt-3" value="icon">
			<div className="space-y-3">
				<div className="flex h-24 items-center justify-center rounded-lg bg-muted/30">
					{iconDraft.trim() ? (
						<GlyphDisplay
							alt=""
							className="rounded-lg"
							size={64}
							value={{
								kind: "icon",
								id: iconDraft,
								...(iconColor ? { color: iconColor } : undefined),
								...(ditherAsBg ? { dither } : undefined),
							}}
						/>
					) : (
						<span className="text-muted-foreground text-sm">Pick an icon</span>
					)}
				</div>

				<div className="relative">
					<Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						aria-label="Search icons"
						className="pl-9"
						onChange={(e) => setIconQuery(e.target.value)}
						placeholder="Search Iconify (Lucide, MDI, Tabler, …)"
						value={iconQuery}
					/>
				</div>

				<div className="space-y-1.5">
					<span className="text-muted-foreground text-xs">Color</span>
					<div className="flex flex-wrap gap-1.5">
						{GLYPH_ICON_COLORS.map((swatch) => {
							const active = iconColor === swatch.value;
							const swatchStyle: GlyphPickerDrawingStyle | undefined =
								swatch.value
									? { "--glyph-picker-swatch-color": swatch.value }
									: undefined;
							return (
								<button
									aria-label={swatch.label}
									aria-pressed={active}
									className={cn(
										"size-6 rounded-full outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring",
										styles.colorSwatch,
										!swatch.value && styles.colorCycle,
										active ? "ring-2 ring-foreground" : "ring-1 ring-border"
									)}
									key={swatch.label}
									onClick={() => setIconColor(swatch.value)}
									style={swatchStyle}
									title={swatch.label}
									type="button"
								/>
							);
						})}
					</div>
				</div>

				<DitherLayerControls
					dither={dither}
					enabled={ditherAsBg}
					onChange={setDither}
					onEnabledChange={setDitherAsBg}
					showToggle
				/>

				<div className="h-48 overflow-hidden rounded-lg border border-border">
					{iconLoading ? (
						<div className="flex h-full items-center justify-center">
							<Spinner />
						</div>
					) : iconError ? (
						<div className="flex h-full items-center justify-center px-4 text-center text-muted-foreground text-sm">
							{iconError}
						</div>
					) : iconHits.length === 0 ? (
						<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
							No icons found
						</div>
					) : (
						<ScrollArea className="h-full">
							<div className="grid grid-cols-8 gap-1 p-2">
								{iconHits.map((hit) => {
									const active = iconDraft === hit.id;
									const safePreviewUrl = safeMediaUrl(hit.previewUrl);
									return (
										<button
											aria-label={hit.id}
											aria-pressed={active}
											className={cn(
												"flex aspect-square items-center justify-center rounded-md outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
												active && "bg-accent ring-2 ring-primary"
											)}
											key={hit.id}
											onClick={() => setIconDraft(hit.id)}
											title={hit.id}
											type="button"
										>
											{}
											{}
											{safePreviewUrl ? (
												<img alt="" className="size-5" src={safePreviewUrl} />
											) : null}
										</button>
									);
								})}
							</div>
						</ScrollArea>
					)}
				</div>
			</div>
		</TabsContent>
	);
}
