"use client";

import { useAvatarContributions } from "@ryu/ui/components/avatar-contributions.tsx";
import {
	DitherGradient,
	type GradientDirection,
} from "@ryu/ui/components/dither-kit/gradient.tsx";
import {
	type DitherColor,
	isDitherColor,
} from "@ryu/ui/components/dither-kit/palette.ts";
import type { ExpressiveAnimationSelection } from "@ryu/ui/components/expressive-animation.ts";
import { PLAIN_COSTUME } from "@ryu/ui/components/ghost-costume.ts";
import {
	dicebearUrl,
	type GlyphDitherValue,
	type GlyphValue,
	isGlyphIconColor,
} from "@ryu/ui/components/glyph.ts";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { Logo } from "@ryu/ui/components/logo.tsx";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type CSSProperties, lazy, type ReactNode, Suspense } from "react";
import { extendTailwindMerge } from "tailwind-merge";
import {
	AVATAR_CONVERSATION_POSES,
	type AvatarConversationState,
	useAvatarConversationState,
} from "./avatar-conversation.tsx";
import styles from "./glyph-display.module.css";

/* The costume renderer is a large SVG module only costumed ghosts need, so it
   loads on first use instead of riding along with every avatar. */
const GhostCostumeArt = lazy(() =>
	import("@ryu/ui/components/ghost-costume-art.tsx").then((loaded) => ({
		default: loaded.GhostCostumeArt,
	}))
);
const AvatarStyleArt = lazy(() =>
	import("@ryu/ui/components/avatar-style-art.tsx").then((loaded) => ({
		default: loaded.AvatarStyleArt,
	}))
);

// Teach class composition the real inherited-radius utility, so it retains the
// existing final-owner precedence previously supplied by rounded-[inherit].
const mergeInheritedGlyphClasses = extendTailwindMerge({
	extend: { classGroups: { rounded: ["rounded-inherit"] } },
});

interface GlyphDrawingStyle extends CSSProperties {
	"--glyph-color"?: string;
	"--glyph-emoji-font-size"?: string;
	"--glyph-size": string;
	"--muted-foreground"?: string;
}

const DITHER_DIRECTIONS: GradientDirection[] = ["up", "down", "left", "right"];

function resolveDither(dither: GlyphDitherValue) {
	const from: DitherColor = isDitherColor(dither.from) ? dither.from : "grey";
	const to: DitherColor | "transparent" = isDitherColor(dither.to)
		? dither.to
		: "transparent";
	const direction: GradientDirection =
		DITHER_DIRECTIONS.find((d) => d === dither.direction) ?? "up";
	return { from, to, direction };
}

/** Full-bleed dither layer for use behind an icon/emoji foreground. */
function DitherBackdrop({ dither }: { dither: GlyphDitherValue }) {
	const { from, to, direction } = resolveDither(dither);
	return (
		<span aria-hidden className="absolute inset-0 overflow-hidden">
			<DitherGradient direction={direction} from={from} to={to} />
		</span>
	);
}

/**
 * Render any {@link GlyphValue}. Hosts pass a `fallback` for the null / empty
 * case (engine logo, folder icon, etc.). Icons and emojis may include an
 * optional dither background; DiceBear, expressive ghosts, and uploads never do.
 */
export function GlyphDisplay({
	value,
	fallback,
	size = 16,
	className,
	alt = "",
	animated = true,
	animation,
	thinking = false,
	conversationState,
	tone = "default",
	corners = "default",
}: {
	/** Accessible alt for image-like glyphs; decorative when empty. */
	alt?: string;
	tone?: "default" | "muted";
	corners?: "default" | "circle" | "compact" | "inherit";
	/** Override the animation for an expressive glyph at render time. */
	animation?: ExpressiveAnimationSelection;
	/** Disable expression cycling and gaze/blink motion for dense picker previews. */
	animated?: boolean;
	className?: string;
	fallback?: ReactNode;
	/** Square footprint in px (font-size for emoji, Icon size, img box). */
	size?: number;
	/** Runtime working state; expressive ghosts use the orbit animation to think. */
	thinking?: boolean;
	conversationState?: AvatarConversationState;
	value: GlyphValue;
}) {
	const contextState = useAvatarConversationState();
	const avatarContributions = useAvatarContributions();
	const presentationClasses = cn(
		tone === "muted" && "text-muted-foreground",
		corners === "circle" && "rounded-full object-cover",
		corners === "compact" && "rounded-glyph-compact object-contain"
	);
	if (presentationClasses) {
		className = cn(presentationClasses, className);
	}
	if (corners === "inherit") {
		className = mergeInheritedGlyphClasses(
			className,
			"rounded-inherit object-cover"
		);
	}
	const glyphSizeStyle: GlyphDrawingStyle = { "--glyph-size": `${size}px` };
	if (value?.kind === "avatar") {
		const safeDataUrl = safeMediaUrl(value.dataUrl);
		if (!safeDataUrl) {
			return fallback ?? null;
		}
		return (
			<img
				alt={alt}
				className={cn("shrink-0 object-cover", styles.frame, className)}
				draggable={false}
				src={safeDataUrl}
				style={glyphSizeStyle}
			/>
		);
	}
	if (value?.kind === "emoji") {
		const emojiStyle: GlyphDrawingStyle = {
			"--glyph-size": `${size}px`,
			"--glyph-emoji-font-size": `${size * 0.72}px`,
		};
		return (
			<span
				aria-hidden={alt ? undefined : true}
				aria-label={alt || undefined}
				className={cn(
					"relative flex shrink-0 items-center justify-center overflow-hidden leading-none",
					styles.emoji,
					className
				)}
				role={alt ? "img" : undefined}
				style={emojiStyle}
			>
				{value.dither ? <DitherBackdrop dither={value.dither} /> : null}
				<span className="relative z-10">{value.emoji}</span>
			</span>
		);
	}
	if (value?.kind === "icon") {
		const iconStyle: GlyphDrawingStyle = {
			"--glyph-size": `${size}px`,
			"--glyph-color": isGlyphIconColor(value.color) ? value.color : undefined,
		};
		return (
			<span
				className={cn(
					"relative flex shrink-0 items-center justify-center overflow-hidden",
					iconStyle["--glyph-color"] === undefined
						? styles.frame
						: styles.coloredFrame,
					className
				)}
				style={iconStyle}
			>
				{value.dither ? <DitherBackdrop dither={value.dither} /> : null}
				<span className="relative z-10 flex items-center justify-center">
					<Icon icon={value.id} label={alt || undefined} size={size * 0.55} />
				</span>
			</span>
		);
	}
	if (value?.kind === "dicebear") {
		return (
			<img
				alt={alt}
				className={cn("shrink-0 object-cover", styles.frame, className)}
				draggable={false}
				src={dicebearUrl(value.style, value.seed, { size })}
				style={glyphSizeStyle}
			/>
		);
	}
	if (value?.kind === "avatar_style") {
		const style = avatarContributions.styles.find(
			(row) => row.id === value.style
		);
		if (!style) {
			// The style's plugin is not installed or is turned off.
			return <>{fallback}</>;
		}
		return (
			<span
				aria-hidden={alt ? undefined : true}
				aria-label={alt || undefined}
				className={cn("relative inline-flex shrink-0", styles.frame, className)}
				data-avatar-style={style.id}
				role={alt ? "img" : undefined}
				style={glyphSizeStyle}
			>
				<Suspense fallback={null}>
					<AvatarStyleArt selection={value} size={size} style={style} />
				</Suspense>
			</span>
		);
	}
	if (value?.kind === "expressive") {
		const reactive = value.behavior === "conversation";
		const activity =
			conversationState ?? (thinking ? "thinking" : contextState);
		const pose = reactive
			? AVATAR_CONVERSATION_POSES[activity]
			: {
					expression: value.expression,
					animation: thinking
						? ("orbit" as const)
						: (animation ?? value.animation),
				};
		const variant = value.variant ?? "expressive";
		if (variant === "costume") {
			return (
				<span
					aria-hidden={alt ? undefined : true}
					aria-label={alt || undefined}
					className={cn(
						"relative inline-flex shrink-0",
						styles.frame,
						className
					)}
					data-avatar-behavior="costume"
					role={alt ? "img" : undefined}
					style={glyphSizeStyle}
				>
					{/* The sized span holds the slot while the renderer loads. */}
					<Suspense fallback={null}>
						<GhostCostumeArt
							costume={value.costume ?? PLAIN_COSTUME}
							framing="avatar"
							size={size}
						/>
					</Suspense>
				</span>
			);
		}
		const motion = animated && value.animated !== false;
		const logoProps = {
			animated: motion,
			animation: pose.animation,
			expression: pose.expression,
			eyeScale: value.eyeScale,
			animationDuration: value.animationDuration,
			colors: value.colors,
			size: `${size}px`,
		};
		const expressiveStyle: GlyphDrawingStyle = {
			"--glyph-size": `${size}px`,
			"--glyph-color":
				variant === "default" || variant === "3d"
					? undefined
					: value.colors?.c1,
			"--muted-foreground": value.colors?.c1 ? value.colors.c1 : undefined,
		};
		return (
			<span
				aria-hidden={alt ? undefined : true}
				aria-label={alt || undefined}
				className={cn(
					"relative inline-flex shrink-0",
					expressiveStyle["--glyph-color"] === undefined
						? styles.frame
						: styles.coloredFrame,
					className
				)}
				data-avatar-behavior={value.behavior ?? "custom"}
				data-avatar-state={reactive ? activity : undefined}
				role={alt ? "img" : undefined}
				style={expressiveStyle}
			>
				{variant === "default" ? (
					<>
						<Logo {...logoProps} showEyes={false} variant="default" />
						<span className="absolute inset-0">
							<Logo {...logoProps} variant="expressive" />
						</span>
					</>
				) : (
					<span inert={variant === "3d"}>
						<Logo
							{...logoProps}
							bodyStyle={value.bodyStyle ?? "orb"}
							variant={variant === "outline" ? "expressive" : variant}
						/>
					</span>
				)}
			</span>
		);
	}

	if (value?.kind === "dither") {
		const { from, to, direction } = resolveDither(value.dither);
		return (
			<span
				aria-hidden={alt ? undefined : true}
				aria-label={alt || undefined}
				className={cn(
					"relative inline-block shrink-0 overflow-hidden",
					styles.frame,
					className
				)}
				role={alt ? "img" : undefined}
				style={glyphSizeStyle}
			>
				<DitherGradient direction={direction} from={from} to={to} />
			</span>
		);
	}
	return <>{fallback}</>;
}
