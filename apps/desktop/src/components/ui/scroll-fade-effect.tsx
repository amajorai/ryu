// Scroll fade effect: fades content edges as you scroll, driven by CSS
// scroll-driven animations (`animation-timeline: scroll(self)`). The mask
// utilities live in src/index.css (`scroll-fade-effect-y`).

import { cn } from "@ryu/ui/lib/utils";
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
		<div className={cn("scroll-fade-effect-y overflow-y-auto", className)}>
			{children}
		</div>
	);
}
