"use client";

import type { useAvatarContributions } from "@ryu/ui/components/avatar-contributions.tsx";
import { defaultAvatarStyleValue } from "@ryu/ui/components/avatar-style-controls.tsx";
import { isDitherColor } from "@ryu/ui/components/dither-kit/palette.ts";
import {
	DEFAULT_DICEBEAR_STYLE,
	type GlyphDitherValue,
	type GlyphIconHit,
	type GlyphKind,
	type GlyphValue,
	glyphDitherOf,
	randomDicebearSeed,
	searchGlyphIcons,
	tabForGlyphValue,
} from "@ryu/ui/components/glyph.ts";
import { useCallback, useEffect, useState } from "react";
import type { GhostAvatarAppearance } from "./ghost-avatar.ts";
import { DEFAULT_DITHER, type Dimensions } from "./glyph-picker-constants.ts";
import { cropToDataUrl } from "./glyph-picker-crop.ts";

interface GlyphPickerStateOptions {
	avatarContributions: ReturnType<typeof useAvatarContributions>;
	isDialogOpen: boolean;
	kinds: readonly GlyphKind[];
	onChange: (value: GlyphValue) => void;
	setIsDialogOpen: (next: boolean) => void;
	value: GlyphValue;
}

/** Draft state, search effects and apply actions for {@link GlyphPicker}. */
export function useGlyphPickerState({
	avatarContributions,
	isDialogOpen,
	kinds,
	onChange,
	setIsDialogOpen,
	value,
}: GlyphPickerStateOptions) {
	const [tab, setTab] = useState<GlyphKind>(kinds[0] ?? "avatar");

	// Upload / crop
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [rendered, setRendered] = useState<Dimensions | null>(null);
	const [zoom, setZoom] = useState(1);

	// Icon
	const [iconQuery, setIconQuery] = useState("");
	const [iconDebounced, setIconDebounced] = useState("");
	const [iconHits, setIconHits] = useState<GlyphIconHit[]>([]);
	const [iconLoading, setIconLoading] = useState(false);
	const [iconError, setIconError] = useState<string | null>(null);
	const [iconDraft, setIconDraft] = useState("");
	const [iconColor, setIconColor] = useState<string | undefined>(undefined);

	// DiceBear
	const [diceStyle, setDiceStyle] = useState<string>(DEFAULT_DICEBEAR_STYLE);
	const [diceSeed, setDiceSeed] = useState(() => randomDicebearSeed());

	const [ghostAppearance, setGhostAppearance] = useState<GhostAvatarAppearance>(
		{ variant: "3d", bodyStyle: "orb", behavior: "custom" }
	);
	// Expressive ghost avatar
	const [expressiveSelection, setExpressiveSelection] =
		useState<Extract<GlyphValue, { kind: "expressive" }>["expression"]>(
			"random"
		);
	const [expressiveAnimationSelection, setExpressiveAnimationSelection] =
		useState<
			NonNullable<Extract<GlyphValue, { kind: "expressive" }>["animation"]>
		>("random");

	// Marketplace avatar style
	const [styleDraft, setStyleDraft] = useState<
		Extract<GlyphValue, { kind: "avatar_style" }>
	>(() => defaultAvatarStyleValue(avatarContributions.styles[0]?.id ?? ""));

	// Dither — standalone tab and/or background under icon/emoji
	const [dither, setDither] = useState<GlyphDitherValue>(DEFAULT_DITHER);
	const [ditherAsBg, setDitherAsBg] = useState(false);

	// Seed drafts from the current value whenever the dialog opens.
	useEffect(() => {
		if (!isDialogOpen) {
			return;
		}
		setTab(tabForGlyphValue(value, kinds));
		setPreviewUrl(null);
		setRendered(null);
		setZoom(1);
		setIconQuery("");
		setIconDebounced("");
		setIconError(null);
		if (value?.kind === "icon") {
			setIconDraft(value.id);
			setIconColor(value.color);
		} else {
			setIconDraft("");
			setIconColor(undefined);
		}
		if (value?.kind === "dicebear") {
			setDiceStyle(value.style);
			setDiceSeed(value.seed);
		} else {
			setDiceStyle(DEFAULT_DICEBEAR_STYLE);
			setDiceSeed(randomDicebearSeed());
		}
		if (value?.kind === "expressive") {
			setGhostAppearance({ ...value });
			setExpressiveSelection(value.expression);
			setExpressiveAnimationSelection(value.animation ?? "random");
		} else {
			setGhostAppearance({
				variant: "3d",
				bodyStyle: "orb",
				behavior: "custom",
			});
			setExpressiveSelection("random");
			setExpressiveAnimationSelection("random");
		}
		if (value?.kind === "avatar_style") {
			setStyleDraft({ ...value });
		} else {
			setStyleDraft(
				defaultAvatarStyleValue(avatarContributions.styles[0]?.id ?? "")
			);
		}
		const layered = glyphDitherOf(value);
		if (layered) {
			setDither({
				from: isDitherColor(layered.from) ? layered.from : "green",
				to: isDitherColor(layered.to) ? layered.to : null,
				direction: layered.direction,
			});
			setDitherAsBg(value?.kind === "icon" || value?.kind === "emoji");
		} else {
			setDither(DEFAULT_DITHER);
			setDitherAsBg(false);
		}
	}, [isDialogOpen, value, kinds, avatarContributions.styles]);

	// Debounce icon search.
	useEffect(() => {
		const t = setTimeout(() => setIconDebounced(iconQuery), 280);
		return () => clearTimeout(t);
	}, [iconQuery]);

	// Run Iconify search when the icon tab is active.
	useEffect(() => {
		if (!(isDialogOpen && tab === "icon")) {
			return;
		}
		let cancelled = false;
		setIconLoading(true);
		setIconError(null);
		searchGlyphIcons(iconDebounced)
			.then((hits) => {
				if (!cancelled) {
					setIconHits(hits);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setIconError("Couldn't load icons. Check your connection.");
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIconLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [isDialogOpen, tab, iconDebounced]);

	const handleFileSelect = useCallback((file: File) => {
		const reader = new FileReader();
		reader.onload = (e) => {
			// SAFETY: this private reader's only operation is readAsDataURL(file)
			// below. FileReader's successful load event therefore exposes a data
			// URL string, not the ArrayBuffer produced by readAsArrayBuffer. The
			// original optional-target/null fallback is retained.
			setPreviewUrl((e.target?.result as string | undefined) ?? null);
			setRendered(null);
			setZoom(1);
		};
		reader.readAsDataURL(file);
	}, []);

	const applyAvatar = useCallback(async () => {
		if (!previewUrl) {
			return;
		}
		const dataUrl = await cropToDataUrl(previewUrl, zoom);
		if (dataUrl) {
			onChange({ kind: "avatar", dataUrl });
		}
		setIsDialogOpen(false);
	}, [previewUrl, zoom, onChange, setIsDialogOpen]);

	const applyIcon = useCallback(() => {
		const id = iconDraft.trim();
		if (!id) {
			return;
		}
		onChange({
			kind: "icon",
			id,
			...(iconColor ? { color: iconColor } : undefined),
			...(ditherAsBg ? { dither } : undefined),
		});
		setIsDialogOpen(false);
	}, [iconDraft, iconColor, ditherAsBg, dither, onChange, setIsDialogOpen]);

	const applyEmoji = useCallback(
		(emoji: string) => {
			if (!emoji) {
				return;
			}
			onChange({
				kind: "emoji",
				emoji,
				...(ditherAsBg ? { dither } : undefined),
			});
			setIsDialogOpen(false);
		},
		[ditherAsBg, dither, onChange, setIsDialogOpen]
	);

	const applyDicebear = useCallback(() => {
		onChange({
			kind: "dicebear",
			style: diceStyle,
			seed: diceSeed.trim() || randomDicebearSeed(),
		});
		setIsDialogOpen(false);
	}, [diceStyle, diceSeed, onChange, setIsDialogOpen]);

	const applyAvatarStyle = useCallback(() => {
		if (!styleDraft.style) {
			return;
		}
		onChange({ ...styleDraft, seed: styleDraft.seed.trim() || "ryu" });
		setIsDialogOpen(false);
	}, [styleDraft, onChange, setIsDialogOpen]);

	const applyDither = useCallback(() => {
		onChange({ kind: "dither", dither });
		setIsDialogOpen(false);
	}, [dither, onChange, setIsDialogOpen]);

	const applyExpressive = useCallback(() => {
		onChange({
			...ghostAppearance,
			animation: expressiveAnimationSelection,
			kind: "expressive",
			expression: expressiveSelection,
		});
		setIsDialogOpen(false);
	}, [
		ghostAppearance,
		expressiveAnimationSelection,
		expressiveSelection,
		onChange,
		setIsDialogOpen,
	]);

	return {
		tab,
		setTab,
		previewUrl,
		setPreviewUrl,
		rendered,
		setRendered,
		zoom,
		setZoom,
		iconQuery,
		setIconQuery,
		iconHits,
		iconLoading,
		iconError,
		iconDraft,
		setIconDraft,
		iconColor,
		setIconColor,
		diceStyle,
		setDiceStyle,
		diceSeed,
		setDiceSeed,
		ghostAppearance,
		setGhostAppearance,
		expressiveSelection,
		setExpressiveSelection,
		expressiveAnimationSelection,
		setExpressiveAnimationSelection,
		styleDraft,
		setStyleDraft,
		dither,
		setDither,
		ditherAsBg,
		setDitherAsBg,
		handleFileSelect,
		applyAvatar,
		applyIcon,
		applyEmoji,
		applyDicebear,
		applyAvatarStyle,
		applyDither,
		applyExpressive,
	};
}

export type GlyphPickerState = ReturnType<typeof useGlyphPickerState>;
