"use client";

import styles from "./glyph-picker.module.css";

/**
 * Shared glyph picker — the single primitive for picking an entity icon /
 * avatar across the product (agents, project folders, spaces, pages, meetings).
 *
 * Allowed kinds are decided here via {@link GLYPH_PRESETS} (or an explicit
 * allowlist). The canonical set is avatar · icon · emoji · dicebear; agents
 * additionally allow expressive ghost faces, marketplace avatar styles (shown
 * only when an enabled plugin contributes one), and a standalone dither gradient.
 * Icons and emojis can also take dither as an optional *background* layer
 * (DiceBear and expressive faces cannot).
 */

import { useAvatarContributions } from "@ryu/ui/components/avatar-contributions.tsx";
import { AvatarStyleControls } from "@ryu/ui/components/avatar-style-controls.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	type GlyphKind,
	type GlyphPresetName,
	type GlyphValue,
	resolveGlyphKinds,
} from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Dices, ImagePlus, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import {
	type GlyphPickerDrawingStyle,
	TAB_LABEL,
} from "./glyph-picker-constants.ts";
import { GlyphPickerDicebearTab } from "./glyph-picker-dicebear-tab.tsx";
import { GlyphPickerDitherTab } from "./glyph-picker-dither-tab.tsx";
import { GlyphPickerEmojiTab } from "./glyph-picker-emoji-tab.tsx";
import { GlyphPickerExpressiveTab } from "./glyph-picker-expressive-tab.tsx";
import { GlyphPickerIconTab } from "./glyph-picker-icon-tab.tsx";
import { useGlyphPickerState } from "./glyph-picker-state.ts";
import { GlyphPickerUploadTab } from "./glyph-picker-upload-tab.tsx";

export interface GlyphPickerProps {
	/**
	 * Allowed kinds, or a {@link GlyphPresetName} (`"entity"` | `"agent"`).
	 * Defaults to `"entity"` — avatar, icon, emoji, dicebear.
	 */
	allowed?: readonly GlyphKind[] | GlyphPresetName;
	className?: string;
	/** Show a clear/remove affordance when a value is set. Default true. */
	clearable?: boolean;
	/** Optional description under the title (e.g. the entity name). */
	description?: string;
	disabled?: boolean;
	/** Shown when no custom glyph is set (engine logo, folder icon, …). */
	fallback?: ReactNode;
	/** Called with the picked glyph, or null when cleared. */
	onChange: (value: GlyphValue) => void;
	/**
	 * Controlled open state. When omitted the picker owns its own dialog and
	 * renders a clickable preview trigger (agent-field style). When provided,
	 * only the dialog is rendered (sidebar "Change icon…" style).
	 */
	onOpenChange?: (open: boolean) => void;
	open?: boolean;
	/** Edge length of the resting preview trigger in px. */
	previewSize?: number;
	/** Dialog title. */
	title?: string;
	value: GlyphValue;
}

/**
 * Unified glyph picker dialog (+ optional clickable preview trigger).
 *
 * Prefer this over bespoke emoji grids / icon text fields so every surface
 * offers the same avatar · icon · emoji · dicebear options.
 */
export function GlyphPicker({
	value,
	onChange,
	fallback,
	disabled = false,
	className,
	title = "Choose icon",
	description,
	allowed = "entity",
	previewSize = 40,
	clearable = true,
	open: openProp,
	onOpenChange: onOpenChangeProp,
}: GlyphPickerProps) {
	const avatarContributions = useAvatarContributions();
	const hasAvatarStyles = avatarContributions.styles.length > 0;
	const allowedKinds = resolveGlyphKinds(allowed);
	// Marketplace styles get a tab only when an enabled plugin contributes one,
	// or when the current value already uses one (so it stays editable).
	const keepStyleTab = hasAvatarStyles || value?.kind === "avatar_style";
	const kinds = useMemo(
		() =>
			keepStyleTab
				? allowedKinds
				: allowedKinds.filter((kind) => kind !== "avatar_style"),
		[allowedKinds, keepStyleTab]
	);
	const controlled = openProp !== undefined;
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const isDialogOpen = controlled ? Boolean(openProp) : uncontrolledOpen;
	const setIsDialogOpen = useCallback(
		(next: boolean) => {
			if (!controlled) {
				setUncontrolledOpen(next);
			}
			onOpenChangeProp?.(next);
		},
		[controlled, onOpenChangeProp]
	);

	const fileInputRef = useRef<HTMLInputElement>(null);
	const state = useGlyphPickerState({
		avatarContributions,
		isDialogOpen,
		kinds,
		onChange,
		setIsDialogOpen,
		value,
	});
	const {
		tab,
		setTab,
		previewUrl,
		iconDraft,
		styleDraft,
		setStyleDraft,
		handleFileSelect,
		applyAvatar,
		applyIcon,
		applyDicebear,
		applyExpressive,
		applyAvatarStyle,
		applyDither,
	} = state;

	const previewSizeStyle: GlyphPickerDrawingStyle = {
		"--glyph-picker-square-size": `${previewSize}px`,
	};
	const dialog = (
		<Dialog onOpenChange={setIsDialogOpen} open={isDialogOpen}>
			<DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-140 *:[button]:hidden">
				<DialogDescription className="sr-only">
					{description ?? title}
				</DialogDescription>
				<DialogHeader className="contents space-y-0 text-left">
					<DialogTitle className="border-b px-4 py-3 text-base">
						{title}
						{description ? (
							<span className="mt-0.5 block truncate font-normal text-muted-foreground text-xs">
								{description}
							</span>
						) : null}
					</DialogTitle>
				</DialogHeader>

				<Tabs
					className="min-h-0 overflow-y-auto px-4 pt-3"
					onValueChange={(v) => setTab(v)}
					value={tab}
				>
					<TabsList className="w-full flex-wrap">
						{kinds.map((kind) => (
							<TabsTrigger key={kind} value={kind}>
								{TAB_LABEL[kind]}
							</TabsTrigger>
						))}
					</TabsList>

					{/* ── Upload ── */}
					{kinds.includes("avatar") ? (
						<GlyphPickerUploadTab fileInputRef={fileInputRef} state={state} />
					) : null}

					{/* ── Iconify ── */}
					{kinds.includes("icon") ? <GlyphPickerIconTab state={state} /> : null}

					{/* ── Emoji (emoji-mart) ── */}
					{kinds.includes("emoji") ? (
						<GlyphPickerEmojiTab state={state} />
					) : null}

					{/* ── Expressive ghost ── */}
					{kinds.includes("expressive") ? (
						<GlyphPickerExpressiveTab state={state} />
					) : null}

					{/* ── DiceBear ── */}
					{kinds.includes("dicebear") ? (
						<GlyphPickerDicebearTab state={state} />
					) : null}

					{/* ── Marketplace avatar styles ── */}
					{kinds.includes("avatar_style") ? (
						<TabsContent className="pt-3" value="avatar_style">
							<AvatarStyleControls
								onChange={setStyleDraft}
								value={styleDraft}
							/>
						</TabsContent>
					) : null}

					{/* ── Dither-only (agent) ── */}
					{kinds.includes("dither") ? (
						<GlyphPickerDitherTab state={state} />
					) : null}
				</Tabs>

				<DialogFooter className="shrink-0 border-t px-4 py-3">
					{clearable && value ? (
						<Button
							className="mr-auto"
							onClick={() => {
								onChange(null);
								setIsDialogOpen(false);
							}}
							type="button"
							variant="ghost"
						>
							Remove
						</Button>
					) : null}
					{tab === "avatar" ? (
						<Button disabled={!previewUrl} onClick={applyAvatar} type="button">
							Apply
						</Button>
					) : null}
					{tab === "icon" ? (
						<Button
							disabled={!iconDraft.trim()}
							onClick={applyIcon}
							type="button"
						>
							Use icon
						</Button>
					) : null}
					{tab === "dicebear" ? (
						<Button onClick={applyDicebear} type="button">
							<Dices className="size-4" />
							Use avatar
						</Button>
					) : null}
					{tab === "expressive" ? (
						<Button onClick={applyExpressive} type="button">
							Use ghost avatar
						</Button>
					) : null}
					{tab === "avatar_style" ? (
						<Button
							disabled={
								!avatarContributions.styles.some(
									(row) => row.id === styleDraft.style
								)
							}
							onClick={applyAvatarStyle}
							type="button"
						>
							Use avatar
						</Button>
					) : null}
					{tab === "dither" ? (
						<Button onClick={applyDither} type="button">
							Use gradient
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);

	// Controlled-only mode: host owns the trigger (e.g. sidebar context menu).
	if (controlled) {
		return (
			<>
				{dialog}
				<input
					accept="image/jpeg,image/png,image/webp,image/svg+xml"
					aria-label="Upload image file"
					className="sr-only"
					disabled={disabled}
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) {
							handleFileSelect(file);
							e.target.value = "";
						}
					}}
					ref={fileInputRef}
					type="file"
				/>
			</>
		);
	}

	return (
		<>
			<div className={cn("relative", className)}>
				<button
					aria-label={value ? "Change icon" : "Set icon"}
					className={cn(
						"group/glyph relative flex items-center justify-center overflow-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
						styles.square
					)}
					disabled={disabled}
					onClick={() => setIsDialogOpen(true)}
					style={previewSizeStyle}
					type="button"
				>
					<GlyphDisplay
						alt=""
						className="size-full rounded-lg"
						fallback={fallback}
						size={previewSize}
						value={value}
					/>
					{disabled ? null : (
						<span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity group-hover/glyph:opacity-100">
							<ImagePlus className="size-4" />
						</span>
					)}
				</button>
				{clearable && value && !disabled ? (
					<Button
						aria-label="Remove icon"
						className="absolute -top-1.5 -right-1.5 size-5 rounded-full border-2 border-background p-0 shadow-none"
						onClick={() => onChange(null)}
						size="icon"
						type="button"
					>
						<X className="size-3" />
					</Button>
				) : null}
			</div>
			{dialog}
			<input
				accept="image/jpeg,image/png,image/webp,image/svg+xml"
				aria-label="Upload image file"
				className="sr-only"
				disabled={disabled}
				onChange={(e) => {
					const file = e.target.files?.[0];
					if (file) {
						handleFileSelect(file);
						e.target.value = "";
					}
				}}
				ref={fileInputRef}
				type="file"
			/>
		</>
	);
}
