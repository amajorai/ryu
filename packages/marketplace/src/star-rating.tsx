"use client";

import type { CSSProperties } from "react";
import visualStyles from "./marketplace-visual.module.css";

// packages/marketplace/src/star-rating.tsx
//
// Small star-rating primitives for the Marketplace: a read-only `StarRating`
// (fractional average with half-star support) and an interactive
// `StarRatingInput` for the write-review form. Shared by Desktop + Web.
//
// The input follows the Spectrum UI interaction pattern: hover preview, a
// restrained sparkle acknowledgement, and a keyboard-complete radiogroup rather
// than a row of unrelated pressed buttons.

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Star, StarHalf } from "lucide-react";
import { useRef, useState } from "react";

const STAR_VALUES = [1, 2, 3, 4, 5] as const;
const MAX_RATING = 5;

/** One display star for a fractional value: full, half, or empty. */
function DisplayStar({
	position,
	value,
	className,
}: {
	position: number;
	value: number;
	className?: string;
}) {
	const filled = value >= position;
	const half = !filled && value >= position - 0.5;
	if (half) {
		return (
			<span className={cn("relative inline-flex", className)}>
				<Star className="size-full text-muted-foreground/40" />
				<StarHalf className="absolute inset-0 size-full fill-warning text-status-warning" />
			</span>
		);
	}
	return (
		<Star
			className={cn(
				"size-full",
				filled
					? "fill-warning text-status-warning"
					: "fill-transparent text-muted-foreground/40",
				className
			)}
		/>
	);
}

/** Read-only star display for an average rating, with optional count label. */
export function StarRating({
	value,
	count,
	size = "size-4",
	className,
	showValue = false,
}: {
	value: number;
	/** Number of reviews; when provided renders "(N)" after the stars. */
	count?: number;
	/** Tailwind size class, or a pixel size for host-specific detail headers. */
	size?: string | number;
	className?: string;
	/** Render the numeric average before the stars. */
	showValue?: boolean;
}) {
	const tl = useLiteralMessages();
	const rounded = Math.round(value * 10) / 10;
	const ratingStyle: RatingSizeStyle | undefined = isNativeNumber(size)
		? { "--marketplace-size": `${size}px` }
		: undefined;
	const label =
		count === undefined
			? tl("Rated {rating} out of {maxRating}", {
					maxRating: MAX_RATING,
					rating: rounded,
				})
			: tl("Rated {rating} out of {maxRating} from {reviewCount} reviews", {
					maxRating: MAX_RATING,
					rating: rounded,
					reviewCount: formatNumber(count),
				});
	return (
		<span
			aria-label={label}
			className={cn("inline-flex items-center gap-1", className)}
			role="img"
		>
			{showValue ? (
				<span className="font-medium text-xs tabular-nums">
					{rounded.toFixed(1)}
				</span>
			) : null}
			<span aria-hidden="true" className="inline-flex items-center gap-0.5">
				{STAR_VALUES.map((position) => (
					<span
						className={isNativeText(size) ? size : visualStyles.size}
						key={position}
						style={ratingStyle}
					>
						<DisplayStar position={position} value={value} />
					</span>
				))}
			</span>
			{count === undefined ? null : (
				<span className="text-muted-foreground text-xs tabular-nums">
					({formatNumber(count)})
				</span>
			)}
		</span>
	);
}

/** Interactive 1–5 star picker for the write-review form. */
export function StarRatingInput({
	value,
	onChange,
	size = "size-7",
	className,
	disabled = false,
	allowClear = true,
	label = "Rating",
}: {
	value: number;
	onChange: (rating: number) => void;
	size?: string;
	className?: string;
	disabled?: boolean;
	allowClear?: boolean;
	label?: string;
}) {
	const tl = useLiteralMessages();
	const [hover, setHover] = useState<number | null>(null);
	const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const active = hover ?? value;
	const commit = (next: number) => {
		if (disabled) {
			return;
		}
		onChange(allowClear && next === value ? 0 : next);
	};
	const move = (position: number, direction: -1 | 1) => {
		const next = Math.min(MAX_RATING, Math.max(1, position + direction));
		commit(next);
		buttonRefs.current[next - 1]?.focus();
	};

	return (
		<div
			aria-label={label}
			aria-orientation="horizontal"
			className={cn("inline-flex items-center gap-1", className)}
			onMouseLeave={() => setHover(null)}
			role="radiogroup"
		>
			{STAR_VALUES.map((position) => {
				const filled = active >= position;
				return (
					<span className="relative inline-flex" key={position}>
						<button
							aria-checked={value === position}
							aria-label={tl(
								"{position, plural, one {# star} other {# stars}}",
								{ position }
							)}
							className={cn(
								"rounded transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 motion-safe:hover:scale-110",
								size
							)}
							disabled={disabled}
							onClick={() => commit(position)}
							onKeyDown={(event) => {
								if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
									event.preventDefault();
									move(position, -1);
									return;
								}
								if (event.key === "ArrowRight" || event.key === "ArrowUp") {
									event.preventDefault();
									move(position, 1);
									return;
								}
								if (event.key === "Home") {
									event.preventDefault();
									commit(1);
									buttonRefs.current[0]?.focus();
									return;
								}
								if (event.key === "End") {
									event.preventDefault();
									commit(MAX_RATING);
									buttonRefs.current[MAX_RATING - 1]?.focus();
								}
							}}
							onMouseEnter={() => setHover(position)}
							ref={(element) => {
								buttonRefs.current[position - 1] = element;
							}}
							tabIndex={
								value === position || (value === 0 && position === 1) ? 0 : -1
							}
							type="button"
						>
							<Star
								className={cn(
									"size-full",
									filled
										? "fill-warning text-status-warning"
										: "fill-transparent text-muted-foreground/40"
								)}
							/>
						</button>
					</span>
				);
			})}
			<span aria-live="polite" className="sr-only">
				{value > 0
					? tl("{value} out of 5 stars", { value })
					: "No rating selected"}
			</span>
		</div>
	);
}

interface RatingSizeStyle extends CSSProperties {
	"--marketplace-size": string;
}
