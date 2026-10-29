import type { CSSProperties } from "react";
import { z } from "zod";

/** Serialize the native React CSS dimension union for component-owned variables. */
export function cssDimension(
	value: CSSProperties["width"]
): string | undefined {
	const text = z.string().safeParse(value);
	if (text.success) {
		return text.data;
	}
	const number = z.number().safeParse(value);
	return number.success ? `${number.data}px` : undefined;
}
