import { z } from "zod";

/** JSON exchanged with Core and companion APIs; individual endpoints own their fields. */
export type RyuJsonValue =
	| null
	| boolean
	| number
	| string
	| RyuJsonValue[]
	| { [key: string]: RyuJsonValue };

/** Native response values have no request-specific depth or cardinality caps. */
export const jsonResponseValueSchema: z.ZodType<RyuJsonValue> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number(),
		z.string(),
		z.array(jsonResponseValueSchema),
		jsonResponseDocumentSchema,
	])
);

// Zod omits __proto__ from record outputs; preserved transport values still
// retain that own entry, so its original descriptor needs validation too.
export const jsonResponseDocumentSchema = z.custom<{
	[key: string]: RyuJsonValue;
}>((value) => {
	const document = z
		.record(z.string(), jsonResponseValueSchema)
		.safeParse(value);
	if (!document.success) {
		return false;
	}
	const prototypeEntry = Object.getOwnPropertyDescriptor(value, "__proto__");
	return (
		!prototypeEntry ||
		jsonResponseValueSchema.safeParse(prototypeEntry.value).success
	);
});
