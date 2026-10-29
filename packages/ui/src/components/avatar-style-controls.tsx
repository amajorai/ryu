"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { useAvatarContributions } from "@ryu/ui/components/avatar-contributions.tsx";
import {
	accessoriesFor,
	resolveAvatarStyle,
} from "@ryu/ui/components/avatar-parts.ts";
import { AvatarStyleArt } from "@ryu/ui/components/avatar-style-art.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	type GlyphAvatarStyleValue,
	randomDicebearSeed,
} from "@ryu/ui/components/glyph.ts";
import { Input } from "@ryu/ui/components/input.tsx";
import { NativeSelect } from "@ryu/ui/components/native-select.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { RefreshCw } from "lucide-react";

/** A fresh selection for a style, seeded so every region starts filled. */
export function defaultAvatarStyleValue(
	styleId: string,
	seed = randomDicebearSeed()
): GlyphAvatarStyleValue {
	return { kind: "avatar_style", style: styleId, seed };
}

/**
 * Edit a marketplace avatar style: pick the style, then its palette, a seed for
 * a random look, and per-region options, including accessories other plugins
 * contributed for that style's regions.
 */
export function AvatarStyleControls({
	value,
	onChange,
}: {
	onChange: (value: GlyphAvatarStyleValue) => void;
	value: GlyphAvatarStyleValue;
}) {
	const tl = useLiteralMessages();
	const contributions = useAvatarContributions();
	const style = contributions.styles.find((row) => row.id === value.style);
	const resolved = style
		? resolveAvatarStyle(style, value, contributions.accessories)
		: null;
	const setPart = (region: string, pick: string) =>
		onChange({ ...value, parts: { ...value.parts, [region]: pick } });

	return (
		<div className="space-y-3">
			<div className="flex min-h-36 items-center justify-center rounded-lg bg-muted/30">
				{style ? (
					<AvatarStyleArt selection={value} size={96} style={style} />
				) : (
					<p className="text-muted-foreground text-xs">
						This style is not available. Install or turn on its plugin, or pick
						another style.
					</p>
				)}
			</div>

			<div className="h-36 overflow-hidden rounded-lg border border-border">
				<ScrollArea className="h-full">
					<div className="grid grid-cols-4 gap-1.5 p-2 sm:grid-cols-5">
						{contributions.styles.map((row) => {
							const active = row.id === value.style;
							return (
								<button
									aria-label={row.label}
									aria-pressed={active}
									className={cn(
										"flex flex-col items-center gap-1 rounded-md p-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
										active && "bg-accent ring-2 ring-primary"
									)}
									key={row.id}
									onClick={() =>
										onChange(defaultAvatarStyleValue(row.id, value.seed))
									}
									title={row.description ?? row.label}
									type="button"
								>
									<AvatarStyleArt
										selection={{ seed: value.seed || "preview" }}
										size={40}
										style={row}
									/>
									<span className="type-compact w-full truncate text-center text-muted-foreground leading-tight">
										{row.label}
									</span>
								</button>
							);
						})}
					</div>
				</ScrollArea>
			</div>

			<div className="flex items-center gap-2">
				<Input
					aria-label="Avatar style seed"
					onChange={(event) =>
						onChange({ ...value, seed: event.target.value, parts: undefined })
					}
					placeholder="Seed"
					value={value.seed}
				/>
				<Button
					aria-label="Randomize avatar"
					onClick={() =>
						onChange({ ...value, seed: randomDicebearSeed(), parts: undefined })
					}
					size="icon"
					type="button"
					variant="outline"
				>
					<RefreshCw className="size-4" />
				</Button>
			</div>

			{style && resolved ? (
				<div className="grid grid-cols-2 gap-3">
					{style.palettes.length > 1 ? (
						<label className="space-y-1 text-xs">
							Colour
							<NativeSelect
								aria-label="Avatar style colour"
								className="w-full"
								onChange={(event) =>
									onChange({ ...value, palette: event.target.value })
								}
								value={resolved.paletteId}
							>
								{style.palettes.map((palette) => (
									<option key={palette.id} value={palette.id}>
										{palette.label}
									</option>
								))}
							</NativeSelect>
						</label>
					) : null}
					{style.regions.map((region) => {
						const extras = accessoriesFor(contributions, style.id, region.id);
						return (
							<label className="space-y-1 text-xs" key={region.id}>
								{region.label}
								<NativeSelect
									aria-label={tl("Avatar {region}", {
										region: region.label.toLowerCase(),
									})}
									className="w-full"
									onChange={(event) => setPart(region.id, event.target.value)}
									value={resolved.picks[region.id] ?? "none"}
								>
									{region.optional ? <option value="none">None</option> : null}
									{region.options.map((option) => (
										<option key={option.id} value={option.id}>
											{option.label}
										</option>
									))}
									{extras.map((accessory) => (
										<option key={accessory.id} value={accessory.id}>
											{accessory.label}
										</option>
									))}
								</NativeSelect>
							</label>
						);
					})}
				</div>
			) : null}
			<p className="text-muted-foreground text-xs">
				Styles and accessories come from plugins you install from the
				Marketplace. Change the seed for a new random look.
			</p>
		</div>
	);
}
