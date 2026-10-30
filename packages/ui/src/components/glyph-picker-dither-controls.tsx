"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { PALETTE, rgb } from "@ryu/ui/components/dither-kit/palette.ts";
import type { GlyphDitherValue } from "@ryu/ui/components/glyph.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { X } from "lucide-react";
import styles from "./glyph-picker.module.css";
import {
	DIRECTION_OPTIONS,
	DITHER_COLORS,
	type GlyphPickerDrawingStyle,
} from "./glyph-picker-constants.ts";

/** Compact dither controls used as a background layer under icon/emoji. */
export function DitherLayerControls({
	dither,
	onChange,
	enabled,
	onEnabledChange,
	showToggle,
}: {
	dither: GlyphDitherValue;
	enabled: boolean;
	onChange: (next: GlyphDitherValue) => void;
	onEnabledChange: (enabled: boolean) => void;
	/** When false, controls always apply (standalone dither tab). */
	showToggle: boolean;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="space-y-3 rounded-lg border border-border p-3">
			{showToggle ? (
				<button
					aria-pressed={enabled}
					className={cn(
						"flex w-full items-center justify-between rounded-md px-1 py-0.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
					)}
					onClick={() => onEnabledChange(!enabled)}
					type="button"
				>
					<span className="font-medium text-xs">Dither background</span>
					<span
						className={cn(
							"type-compact rounded-full px-2 py-0.5 uppercase tracking-wide",
							enabled
								? "bg-foreground text-background"
								: "bg-muted text-muted-foreground"
						)}
					>
						{enabled ? "On" : "Off"}
					</span>
				</button>
			) : (
				<span className="font-medium text-muted-foreground text-xs">
					Dither
				</span>
			)}

			{(!showToggle || enabled) && (
				<>
					<div className="space-y-1.5">
						<span className="text-muted-foreground text-xs">Colour</span>
						<div className="flex flex-wrap gap-2">
							{DITHER_COLORS.map((color) => {
								const swatchStyle: GlyphPickerDrawingStyle = {
									"--glyph-picker-swatch-color": rgb(PALETTE[color].fill),
								};
								return (
									<button
										aria-label={color}
										aria-pressed={dither.from === color}
										className={cn(
											"size-7 rounded-full outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring",
											styles.colorSwatch,
											dither.from === color
												? "ring-2 ring-foreground"
												: "ring-1 ring-border"
										)}
										key={color}
										onClick={() => onChange({ ...dither, from: color })}
										style={swatchStyle}
										type="button"
									/>
								);
							})}
						</div>
					</div>

					<div className="space-y-1.5">
						<span className="text-muted-foreground text-xs">
							Blend to (optional)
						</span>
						<div className="flex flex-wrap items-center gap-2">
							<button
								aria-label="Fade to transparent"
								aria-pressed={dither.to === null}
								className={cn(
									"flex size-7 items-center justify-center rounded-full text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
									dither.to === null
										? "ring-2 ring-foreground"
										: "ring-1 ring-border"
								)}
								onClick={() => onChange({ ...dither, to: null })}
								type="button"
							>
								<X className="size-3.5" />
							</button>
							{DITHER_COLORS.map((color) => {
								const swatchStyle: GlyphPickerDrawingStyle = {
									"--glyph-picker-swatch-color": rgb(PALETTE[color].fill),
								};
								return (
									<button
										aria-label={tl("Blend to {color}", { color })}
										aria-pressed={dither.to === color}
										className={cn(
											"size-7 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
											styles.colorSwatch,
											dither.to === color
												? "ring-2 ring-foreground"
												: "ring-1 ring-border"
										)}
										key={color}
										onClick={() => onChange({ ...dither, to: color })}
										style={swatchStyle}
										type="button"
									/>
								);
							})}
						</div>
					</div>

					<div className="space-y-1.5">
						<span className="text-muted-foreground text-xs">Direction</span>
						<div className="flex gap-2">
							{DIRECTION_OPTIONS.map((opt) => (
								<button
									aria-label={opt.label}
									aria-pressed={dither.direction === opt.value}
									className={cn(
										"flex size-8 items-center justify-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
										dither.direction === opt.value
											? "bg-foreground text-background"
											: "bg-muted text-muted-foreground hover:bg-muted/70"
									)}
									key={opt.value}
									onClick={() => onChange({ ...dither, direction: opt.value })}
									type="button"
								>
									<opt.Icon className="size-4" />
								</button>
							))}
						</div>
					</div>
				</>
			)}
		</div>
	);
}
