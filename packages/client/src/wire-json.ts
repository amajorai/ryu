import { z } from "zod";

const objectAdmission = z.custom<object>(
	(value) => z.looseObject({}).safeParse(value).success
);
const jsonValueValidation: z.ZodType<z.core.util.JSONType> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.string(),
		z.number(),
		z.literal(Number.POSITIVE_INFINITY),
		z.literal(Number.NEGATIVE_INFINITY),
		z.array(jsonValueValidation),
		z.custom<Record<string, z.core.util.JSONType>>((value) => {
			const object = objectAdmission.safeParse(value);
			return (
				object.success &&
				Object.values(object.data).every(
					(entry) => jsonValueValidation.safeParse(entry).success
				)
			);
		}),
	])
);
/** Validate the complete native JSON result without cloning keys or changing field order. */
export const wireJsonSchema = z.custom<z.core.util.JSONType>(
	(value) => jsonValueValidation.safeParse(value).success
);

export const wireJsonRecordSchema = z.custom<
	Record<string, z.core.util.JSONType>
>(
	(value) =>
		z.looseObject({}).safeParse(value).success &&
		wireJsonSchema.safeParse(value).success
);

export const wireNumberSchema = z.union([
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
