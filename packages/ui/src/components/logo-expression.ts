import { useEffect, useState } from "react";
import {
	type ExpressiveExpressionSelection,
	randomExpressiveExpression,
} from "./expressive.ts";
import { isExpressiveVariant, type LogoProps } from "./logo-shared.ts";

/**
 * The expression an expressive logo currently shows. A named selection stays
 * put; `random` (the default) advances on its own every few seconds while the
 * logo is animated, and rests on `neutral` when it is not.
 */
export function useActiveExpression(
	variant: LogoProps["variant"],
	animated: boolean,
	expression: ExpressiveExpressionSelection | undefined
): ExpressiveExpressionSelection {
	const expressionSelection = expression ?? "random";
	const [activeExpression, setActiveExpression] = useState(() =>
		expressionSelection === "random" && animated
			? randomExpressiveExpression()
			: expressionSelection === "random"
				? "neutral"
				: expressionSelection
	);

	useEffect(() => {
		if (!isExpressiveVariant(variant)) {
			return;
		}
		if (expressionSelection !== "random") {
			setActiveExpression(expressionSelection);
		} else if (!animated) {
			setActiveExpression("neutral");
		}
	}, [animated, expressionSelection, variant]);

	useEffect(() => {
		if (
			!(isExpressiveVariant(variant) && animated) ||
			expressionSelection !== "random"
		) {
			return;
		}
		let timer: ReturnType<typeof setTimeout> | null = null;
		const schedule = () => {
			timer = setTimeout(
				() => {
					setActiveExpression(randomExpressiveExpression());
					schedule();
				},
				2400 + Math.random() * 1800
			);
		};
		schedule();
		return () => {
			if (timer) {
				clearTimeout(timer);
			}
		};
	}, [animated, expressionSelection, variant]);

	return activeExpression;
}
