// packages/marketplace/src/star-rating.tsx
//
// Small star-rating primitives for the Marketplace: a read-only `StarRating`
// (renders a fractional average with half-star support) and an interactive
// `StarRatingInput` for the write-review form. Shared by desktop + web.

import { cn } from "@ryu/ui/lib/utils.ts";
import { Star, StarHalf } from "lucide-react";
import { useState } from "react";

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
				<StarHalf className="absolute inset-0 size-full fill-warning text-warning" />
			</span>
		);
	}
	return (
		<Star
			className={cn(
				"size-full",
				filled
					? "fill-warning text-warning"
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
	/** Tailwind size class for each star (default `size-4`). */
	size?: string;
	className?: string;
	/** Render the numeric average before the stars. */
	showValue?: boolean;
}) {
	const rounded = Math.round(value * 10) / 10;
	const label =
		count === undefined
			? `Rated ${rounded} out of ${MAX_RATING}`
			: `Rated ${rounded} out of ${MAX_RATING} from ${count} reviews`;
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
					<span className={size} key={position}>
						<DisplayStar position={position} value={value} />
					</span>
				))}
			</span>
			{count === undefined ? null : (
				<span className="text-muted-foreground text-xs tabular-nums">
					({count})
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
}: {
	value: number;
	onChange: (rating: number) => void;
	size?: string;
	className?: string;
	disabled?: boolean;
}) {
	const [hover, setHover] = useState<number | null>(null);
	const active = hover ?? value;
	return (
		<div
			className={cn("inline-flex items-center gap-1", className)}
			onMouseLeave={() => setHover(null)}
		>
			{STAR_VALUES.map((position) => {
				const filled = active >= position;
				return (
					<button
						aria-label={`${position} star${position === 1 ? "" : "s"}`}
						aria-pressed={value === position}
						className={cn(
							"rounded transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
							size
						)}
						disabled={disabled}
						key={position}
						onClick={() => onChange(position)}
						onMouseEnter={() => setHover(position)}
						type="button"
					>
						<Star
							className={cn(
								"size-full",
								filled
									? "fill-warning text-warning"
									: "fill-transparent text-muted-foreground/40"
							)}
						/>
					</button>
				);
			})}
		</div>
	);
}
