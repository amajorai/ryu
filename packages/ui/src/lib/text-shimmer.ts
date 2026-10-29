import type { CSSProperties } from "react";

export interface TextShimmerStyle extends CSSProperties {
	"--text-shimmer-duration": string;
}

export const TEXT_SHIMMER_CLASS_NAME =
	"bg-[length:200%_100%] bg-clip-text text-transparent bg-[linear-gradient(110deg,var(--muted-foreground)_30%,var(--foreground)_50%,var(--muted-foreground)_70%)] animate-[beui-text-shimmer_var(--text-shimmer-duration)_linear_infinite]";

export function textShimmerStyle(duration: number): TextShimmerStyle {
	const style: TextShimmerStyle = { "--text-shimmer-duration": `${duration}s` };
	return style;
}
