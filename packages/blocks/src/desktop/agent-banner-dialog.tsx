"use client";

// packages/blocks/src/desktop/agent-banner-dialog.tsx
//
// Banner customisation for the agent editor's profile header: pick a STYLE (the
// generative dither wash, or one of the gradient presets), a COLOUR, and — for
// the dither style only — a direction.
//
// It used to be a strip of bare swatch dots floating on the banner itself. The
// original comment there said they sat on the banner "so the effect is visible
// while choosing", which is the one thing a dialog would otherwise cost — so the
// dialog carries a live preview of the real wash at banner proportions, and the
// controls sit under it. That buys back the visibility and drops the chrome that
// was permanently parked over the top-left corner of every unlocked agent.
//
// The preset list is NOT defined here. It comes from
// `@ryu/ui/components/banner-presets`, which is an adapter over
// `ANIMATED_GRADIENT_PRESETS` — the same shared table the marketplace's listing
// banners paint from. So a gradient added for a listing banner shows up in this
// dialog with no edit, and `prism` means one thing across the app. Nothing in
// this file switches on a preset id.
//
// The washes here are the shared table's STATIC paint, never its WebGL shader:
// a header plus a preview plus seven tiles would be nine GL contexts against a
// browser cap of ~16 that evicts the oldest, which is a known crash on this app.
// The `live` opt-in belongs to a detail hero; see the animated-gradient header.
//
// Prefs stay in localStorage, per agent, exactly as before: this is a purely
// cosmetic per-machine choice, and a Core schema change (plus migration and
// sync) buys nothing for it.

import { PaintBoardIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import {
	type RenderableBackdrop,
	resolveMarketplaceWallpaperSelection,
	toMarketplaceWallpaperSelection,
} from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import {
	BANNER_COLORS,
	BANNER_DIRECTIONS,
	BANNER_PRESETS,
} from "@ryu/ui/components/banner-presets";
import { Button } from "@ryu/ui/components/button";
import {
	ColorPicker,
	ColorPickerContent,
	ColorPickerPanel,
	ColorPickerTrigger,
} from "@ryu/ui/components/color-picker";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils";
import { parseMarketplaceWallpaperSelection } from "@ryuhq/protocol/marketplace-wallpaper";
import { useState } from "react";
import styles from "./agent-banner-dialog.module.css";
import {
	AgentBannerWash,
	BANNER_SWATCHES,
	type BannerPaintStyle,
	bannerSwatchHex,
	hexToHue,
	hueToHex,
	resolveAgentBanner,
} from "./agent-banner-dialog-paint.tsx";
import type { AgentBannerPrefs } from "./agent-banner-dialog-prefs.ts";
import { MarketplaceWallpaperPickerDialog } from "./marketplace-wallpaper-picker.tsx";

export {
	AGENT_BANNER_BASE,
	AgentBannerWash,
	AgentProfileBannerFade,
	type ResolvedAgentBanner,
	resolveAgentBanner,
} from "./agent-banner-dialog-paint.tsx";
export {
	type AgentBannerPreferenceStore,
	type AgentBannerPrefs,
	loadAgentBannerPrefs,
	saveAgentBannerPrefs,
	useAgentBannerPrefs,
} from "./agent-banner-dialog-prefs.ts";

function FieldLabel({ children }: { children: string }) {
	return <h4 className="font-medium text-foreground/70 text-xs">{children}</h4>;
}

/**
 * The customisation dialog. Opened from the banner; every change applies (and
 * persists) immediately, so the footer closes rather than commits.
 */
export function AgentBannerDialog({
	agent,
	marketplaceWallpapers,
	prefs,
	onInstallWallpaper,
	onReset,
	onUpdate,
	storageError,
	loading,
}: {
	/** Stable agent id, or the name in a storyboard without persisted ids. */
	agent: string;
	marketplaceWallpapers: readonly RenderableBackdrop[];
	onInstallWallpaper?: (
		wallpaper: RenderableBackdrop
	) => boolean | Promise<boolean>;
	onReset: () => Promise<boolean>;
	onUpdate: (next: AgentBannerPrefs) => Promise<boolean>;
	prefs: AgentBannerPrefs;
	storageError?: string | null;
	loading?: boolean;
}) {
	const tl = useLiteralMessages();
	const banner = resolveAgentBanner(agent, prefs);
	const isDither = banner.preset.kind === "dither";
	const customHue = isNativeNumber(banner.color) ? banner.color : null;
	const [wallpaperPickerOpen, setWallpaperPickerOpen] = useState(false);
	const selectedWallpaper = parseMarketplaceWallpaperSelection(prefs.wallpaper);
	const renderedWallpaper = resolveMarketplaceWallpaperSelection(
		prefs.wallpaper
	);
	const updateStyle = (next: AgentBannerPrefs) =>
		onUpdate({ ...next, wallpaper: undefined });

	return (
		<>
			<Dialog>
				<DialogTrigger
					render={
						<Button
							appearance="banner-customize"
							disabled={loading}
							size="sm"
							variant="ghost"
						/>
					}
				>
					<HugeiconsIcon className="size-3.5" icon={PaintBoardIcon} />
					Customize
				</DialogTrigger>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Banner</DialogTitle>
						<DialogDescription>
							Choose a style or Marketplace wallpaper. Once the agent is saved,
							its banner is shared across devices connected to this node.
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-4">
						{/* The real wash at banner proportions — the whole reason the swatch
					    strip used to live on the banner. */}
						<div
							className={cn(
								"relative h-24 overflow-hidden rounded-lg",
								styles.base
							)}
							data-testid="banner-preview"
						>
							{renderedWallpaper ? (
								<Backdrop
									className="absolute inset-0"
									definition={renderedWallpaper}
									live={false}
									params={renderedWallpaper.initialParams}
								/>
							) : (
								<AgentBannerWash banner={banner} />
							)}
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Button
								onClick={() => setWallpaperPickerOpen(true)}
								size="sm"
								variant="outline"
							>
								Browse Marketplace wallpapers
							</Button>
							{selectedWallpaper ? (
								<Button
									onClick={() => updateStyle({ wallpaper: undefined })}
									size="sm"
									variant="ghost"
								>
									Use banner style
								</Button>
							) : null}
						</div>
						{storageError ? (
							<p className="text-sm text-status-destructive" role="alert">
								{storageError}
							</p>
						) : null}

						<div className="flex flex-col gap-2">
							<FieldLabel>Style</FieldLabel>
							{/* Fixed column count, not `auto-fill`: the tiles are previews and
						    have to stay wide enough to read as one, so a longer preset
						    table wraps to another row rather than shrinking every tile. */}
							<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
								{BANNER_PRESETS.map((preset) => {
									const active = preset.id === banner.preset.id;
									return (
										<button
											aria-pressed={active}
											className={cn(
												"flex flex-col gap-1 rounded-lg p-1 text-left transition-colors",
												active ? "bg-accent" : "hover:bg-accent/50"
											)}
											data-testid="banner-style-tile"
											key={preset.id}
											onClick={() => updateStyle({ preset: preset.id })}
											type="button"
										>
											<span
												className={cn(
													"relative block h-10 overflow-hidden rounded-md ring-1 ring-inset",
													styles.base,
													active ? "ring-primary" : "ring-border"
												)}
											>
												<AgentBannerWash
													banner={{ ...banner, preset }}
													opacity={0.8}
												/>
											</span>
											<span className="type-caption truncate px-0.5 text-muted-foreground">
												{preset.label}
											</span>
										</button>
									);
								})}
							</div>
						</div>

						<div className="flex flex-col gap-2">
							<FieldLabel>Colour</FieldLabel>
							<div className="flex items-center gap-2">
								{BANNER_COLORS.map((c) => (
									<button
										aria-label={tl("Banner colour {c}", { c })}
										aria-pressed={banner.color === c}
										className={cn(
											"size-6 rounded-full border transition-transform hover:scale-110",
											styles.swatch,
											banner.color === c
												? "border-foreground ring-2 ring-primary"
												: "border-border"
										)}
										key={c}
										onClick={() => updateStyle({ color: c })}
										style={
											{
												"--agent-banner-swatch": BANNER_SWATCHES[c],
											} satisfies BannerPaintStyle as BannerPaintStyle
										}
										type="button"
									/>
								))}
								{/* Custom colour: any hue, not just the six presets. Stored as a
							    number, which both styles accept directly. */}
								<ColorPicker
									onValueChange={(value) =>
										updateStyle({ color: hexToHue(value) })
									}
									swatches={Object.values(BANNER_SWATCHES)}
									value={customHue === null ? "#b497cf" : hueToHex(customHue)}
								>
									<ColorPickerTrigger
										aria-label="Custom banner colour"
										render={
											<button
												className={cn(
													"corner-squircle inline-flex size-6 min-w-12 items-center justify-center gap-2 border bg-background text-foreground hover:bg-muted dark:bg-transparent dark:hover:bg-muted/50",
													styles.customHue,
													customHue !== null && styles.customHueSelected
												)}
												type="button"
											/>
										}
									>
										<span
											aria-hidden="true"
											className={cn(
												"corner-squircle size-5 shrink-0 rounded-sm border border-foreground/15",
												styles.customHuePaint
											)}
											style={
												{
													"--agent-banner-swatch": bannerSwatchHex(
														customHue ?? "purple"
													),
												} satisfies BannerPaintStyle as BannerPaintStyle
											}
										/>
									</ColorPickerTrigger>
									<ColorPickerContent>
										<ColorPickerPanel />
									</ColorPickerContent>
								</ColorPicker>
							</div>
						</div>

						{/* Direction is a dither-only control: a gradient preset carries its
					    own angle, and offering a direction that does nothing would read
					    as a broken control. */}
						{isDither ? (
							<div className="flex flex-col gap-2">
								<FieldLabel>Direction</FieldLabel>
								<div className="flex items-center gap-1.5">
									{BANNER_DIRECTIONS.map((d) => (
										<button
											aria-pressed={banner.direction === d}
											className={cn(
												"rounded-md px-2.5 py-1 text-xs capitalize transition-colors",
												banner.direction === d
													? "bg-primary text-primary-foreground"
													: "bg-muted text-muted-foreground hover:bg-accent"
											)}
											key={d}
											onClick={() => updateStyle({ direction: d })}
											type="button"
										>
											{d}
										</button>
									))}
								</div>
							</div>
						) : null}
					</div>

					<DialogFooter>
						<Button onClick={onReset} size="sm" variant="ghost">
							Reset to default
						</Button>
						<DialogClose render={<Button size="sm" />}>Done</DialogClose>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<MarketplaceWallpaperPickerDialog
				onOpenChange={setWallpaperPickerOpen}
				onSelect={async (wallpaper) => {
					if (onInstallWallpaper && !(await onInstallWallpaper(wallpaper))) {
						return false;
					}
					return (
						(await onUpdate({
							wallpaper: toMarketplaceWallpaperSelection(wallpaper),
						})) !== false
					);
				}}
				open={wallpaperPickerOpen}
				selectedId={selectedWallpaper?.id}
				title="Choose an agent banner wallpaper"
				wallpapers={marketplaceWallpapers}
			/>
		</>
	);
}
