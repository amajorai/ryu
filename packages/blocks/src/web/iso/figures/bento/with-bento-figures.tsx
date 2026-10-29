import type { ReactNode } from "react";
import { BentoFigure } from "./bento-figure.tsx";

/**
 * Give each bento item its card drawing from `group`. Kept out of the client
 * module so server pages can call it.
 */
export function withBentoFigures<T extends { title: string }>(
	group: string,
	items: readonly T[]
): (T & { visual: ReactNode })[] {
	return items.map((item) => ({
		...item,
		visual: <BentoFigure group={group} title={item.title} />,
	}));
}
