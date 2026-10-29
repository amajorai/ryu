// Scroll fade effect: fades content edges as you scroll, driven by CSS
// scroll-driven animations (`animation-timeline: scroll(self)`). The mask
// utility lives in the shared UI stylesheet (`scroll-fade`).

import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";

interface ScrollFadeEffectProps {
	children: ReactNode;
	className?: string;
}

export function ScrollFadeEffect({
	children,
	className,
}: ScrollFadeEffectProps) {
	return (
		<div className={cn("scroll-fade overflow-y-auto", className)}>
			{children}
		</div>
	);
}
