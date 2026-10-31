"use client";
import { Button } from "@ryu/ui/components/button";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { Logo as GhostOrb } from "@ryu/ui/components/logo";
import { PageHeader } from "@ryu/ui/components/page-header";
import { TextSwap } from "@ryu/ui/components/text-swap";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import styles from "./onboarding.module.css";

export interface OnboardingProgressStyle extends CSSProperties {
	"--onboarding-progress": string;
}

/**
 * Kept for callers that still pass a reveal delay. Onboarding steps no longer
 * cascade: each step fades in once, as a whole, through `OnboardingShell`.
 */
export const ONBOARDING_CONTENT_DELAY_MS = 0;

/** `form` is a single reading column; `wide` fits side-by-side choices. */
export type OnboardingShellWidth = "form" | "wide";

const SHELL_WIDTH = {
	form: "max-w-lg",
	wide: "max-w-3xl",
} satisfies Record<OnboardingShellWidth, string>;

/**
 * `stacked` centers the header above the content. `split` is for long steps
 * (lists, multi-field forms): on a wide window the header sits in a left
 * column and the content scrolls on its own in the right column, so the step
 * no longer runs the full height of the window. Narrow windows stack as usual.
 */
export type OnboardingShellLayout = "stacked" | "split";

/**
 * The one onboarding step frame, shared by the block steps and every
 * desktop-only step. It owns the scroll, the drag region, the persona mark, the
 * centered `PageHeader` and a single 200ms fade per step.
 */
export function OnboardingShell({
	title,
	subtitle,
	avatar,
	avatarGlyph,
	children,
	layout = "stacked",
	liveSubtitle = false,
	stepKey,
	width = "form",
}: {
	/** A ready-made persona mark; wins over `avatarGlyph`. */
	avatar?: ReactNode;
	avatarGlyph?: GlyphValue;
	children?: ReactNode;
	layout?: OnboardingShellLayout;
	/**
	 * Morph a string subtitle in place as it changes (rotating status lines on
	 * the auto-advancing steps). The morph cannot wrap, so a long, static
	 * subtitle stays plain text and wraps inside the column.
	 */
	liveSubtitle?: boolean;
	/** Changes when the step changes, so the frame fades in again. */
	stepKey?: string;
	subtitle?: ReactNode;
	title: ReactNode;
	width?: OnboardingShellWidth;
}) {
	let mark = avatar;
	if (mark === undefined) {
		mark = avatarGlyph ? (
			<GlyphDisplay
				alt="Your agent avatar"
				corners="circle"
				size={48}
				value={avatarGlyph}
			/>
		) : (
			<GhostOrb size="48px" variant="outline" />
		);
	}
	const split = layout === "split";
	const header = (
		<PageHeader
			className={cn("w-full text-center", split && "lg:text-left")}
			size="app"
			subtitle={
				liveSubtitle && typeof subtitle === "string" ? (
					<TextSwap>{subtitle}</TextSwap>
				) : (
					subtitle
				)
			}
			subtitleClassName="text-balance"
			title={typeof title === "string" ? <TextSwap>{title}</TextSwap> : title}
			titleClassName={cn("text-balance", split && "lg:text-2xl")}
		/>
	);
	return (
		// The shell fills the window and sits on top of the page wrapper, so the
		// drag region lives here (as it does on LoginView); interactive children
		// override it. The outer box owns the scroll and the inner column uses
		// `min-h-full`, so a short step stays centered and a long one scrolls.
		// In the wide split layout the content column owns the scroll instead.
		<div
			className={cn(
				"scroll-fade h-full w-full overflow-y-auto",
				split && "lg:overflow-hidden"
			)}
		>
			<div
				className={cn(
					"fade-in flex min-h-full w-full animate-in flex-col items-center justify-center gap-8 px-6 py-12 duration-(--duration-base) ease-enter",
					split &&
						"lg:mx-auto lg:grid lg:h-full lg:min-h-0 lg:max-w-6xl lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16 lg:px-12 lg:py-0"
				)}
				data-tauri-drag-region="true"
				key={stepKey}
			>
				<div
					className={cn(
						"flex w-full max-w-xl flex-col items-center gap-6",
						split && "lg:items-start"
					)}
					data-tauri-drag-region="true"
				>
					<div className="shrink-0">{mark}</div>
					{header}
				</div>
				<div
					className={cn(
						"flex w-full flex-col gap-6",
						SHELL_WIDTH[width],
						split &&
							"scroll-fade lg:max-h-full lg:max-w-none lg:overflow-y-auto lg:px-1 lg:py-12",
						split && styles.cardedContent
					)}
				>
					{children}
				</div>
			</div>
		</div>
	);
}

/**
 * The onboarding call to action: `mono` at h-10. `secondary` is the ghost
 * alternative at the same height, so a step's action row never mixes sizes.
 */
export function OnboardingCta({
	className,
	tone = "primary",
	...props
}: Omit<ComponentProps<typeof Button>, "size" | "variant"> & {
	tone?: "primary" | "secondary";
}) {
	return (
		<Button
			className={cn("h-10 px-4", className)}
			variant={tone === "primary" ? "mono" : "ghost"}
			{...props}
		/>
	);
}

/** The right-aligned action row under a step's content. */
export function OnboardingActions({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn("flex flex-wrap items-center justify-end gap-2", className)}
			data-slot="onboarding-actions"
		>
			{children}
		</div>
	);
}

/** Progress bar for auto-advancing steps. It shows reported progress when known
 *  and an indeterminate indicator while a phase has no numeric progress. `done`
 *  pins to 100%. The slim muted track and foreground fill match the onboarding
 *  mono buttons in both themes. */
export function ProgressBar({
	value,
	done,
}: {
	value?: number;
	done?: boolean;
}) {
	const pct = done
		? 100
		: value === undefined
			? null
			: Math.max(0, Math.min(100, value));
	return (
		<div className="mx-auto flex w-60 flex-col gap-1.5">
			<div
				aria-label="Setting up"
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={pct === null ? undefined : Math.round(pct)}
				className="relative h-1 w-full overflow-hidden rounded-full bg-muted"
				role="progressbar"
			>
				{pct === null ? (
					<span aria-hidden="true" className="t-progress-marquee" />
				) : (
					<div
						className={cn(
							"h-full rounded-full bg-foreground duration-300 ease-out",
							styles.progress
						)}
						style={
							{
								"--onboarding-progress": `${pct}%`,
							} satisfies OnboardingProgressStyle as OnboardingProgressStyle
						}
					/>
				)}
			</div>
		</div>
	);
}
