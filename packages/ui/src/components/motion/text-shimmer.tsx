import {
	TEXT_SHIMMER_CLASS_NAME,
	type TextShimmerStyle,
	textShimmerStyle,
} from "@ryu/ui/lib/text-shimmer.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties, ElementType, ReactNode } from "react";

export interface TextShimmerProps {
	as?: ElementType;
	children: ReactNode;
	className?: string;
	duration?: number;
}

/**
 * The props the shimmer actually passes down. A bare `ElementType` intersects
 * every intrinsic element's props, which collapses `children`/`style` to
 * `never`; naming the three props the component sets keeps the polymorphism
 * without that collapse.
 */
type ShimmerHost = ElementType<{
	children?: ReactNode;
	className?: string;
	style?: CSSProperties;
}>;

export function TextShimmer({
	children,
	as = "span",
	duration = 0.9,
	className,
}: TextShimmerProps) {
	// SAFETY: This view names exactly the children/className/style packet
	// passed to React's complete polymorphic ElementType receiver below.
	// It avoids the all-intrinsic-props intersection; it does not promise
	// that a caller-provided component forwards styles or accepts children.
	const Comp = as as ShimmerHost;
	const shimmerStyle: TextShimmerStyle = {
		"--text-shimmer-duration":
			textShimmerStyle(duration)["--text-shimmer-duration"],
	};

	return (
		<Comp
			className={cn("inline-block", TEXT_SHIMMER_CLASS_NAME, className)}
			style={shimmerStyle}
		>
			{children}
		</Comp>
	);
}
