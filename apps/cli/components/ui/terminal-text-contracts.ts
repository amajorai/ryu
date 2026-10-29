import { z } from "zod";

/** OpenTUI text accepts the same string and number primitives as React children,
 * including the JavaScript non-finite numbers accepted by the native renderer. */
export const terminalTextPrimitiveSchema = z.union([
	z.string(),
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
