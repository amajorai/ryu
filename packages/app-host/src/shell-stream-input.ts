import { z } from "zod";

/** Shell stream arguments cross a MessagePort rather than HTTP JSON.
 * Optional properties retain undefined at any depth in command/icon records. */
export type ShellStreamValue =
	| undefined
	| null
	| boolean
	| number
	| string
	| ShellStreamValue[]
	| { [key: string]: ShellStreamValue };

const streamNumberSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const streamValueSchema: z.ZodType<ShellStreamValue> = z.lazy(() =>
	z.union([
		z.undefined(),
		z.null(),
		z.boolean(),
		streamNumberSchema,
		z.string(),
		z.array(streamValueSchema),
		z.record(z.string(), streamValueSchema),
	])
);

/** Keep the existing loose-object/default behavior. The service owns validation
 * of its commands, channels, and icons; unsupported property values are ignored. */
export const shellStreamInputSchema = z
	.record(z.string(), streamValueSchema.catch(undefined))
	.catch(() => ({}));
export type ShellStreamInput = z.output<typeof shellStreamInputSchema>;
