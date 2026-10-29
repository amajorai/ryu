import { z } from "zod";
import { nativeNumberSchema } from "./native-json.ts";

/** Values admitted by canonical package JSON, including absent merge cells. */
export type PackageSerdeValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| PackageSerdeValue[]
	| PackageSerdeObject;
export interface PackageSerdeObject {
	[key: string]: PackageSerdeValue;
}
const primitive = z.union([
	z.string(),
	nativeNumberSchema,
	z.nan(),
	z.boolean(),
	z.null(),
	z.undefined(),
]);
const objectContainer = z.custom<object>((value) => {
	const wrapped = new Object(value);
	return (
		wrapped === value &&
		!Array.isArray(value) &&
		!z.function().safeParse(value).success
	);
});
function admits(
	value: Parameters<typeof primitive.parse>[0],
	ancestors: Set<object>
): boolean {
	if (primitive.safeParse(value).success) {
		return true;
	}
	const object = Array.isArray(value)
		? z.custom<PackageSerdeValue[]>(Array.isArray).safeParse(value)
		: objectContainer.safeParse(value);
	if (!object.success || ancestors.has(object.data)) {
		return false;
	}
	ancestors.add(object.data);
	const valid = Object.values(object.data).every((entry) =>
		admits(entry, ancestors)
	);
	ancestors.delete(object.data);
	return valid;
}
export const packageSerdeSchema = z.custom<PackageSerdeValue>((value) =>
	admits(value, new Set())
);
export const packageSerdeObjectSchema = z.custom<PackageSerdeObject>(
	(value) =>
		objectContainer.safeParse(value).success &&
		packageSerdeSchema.safeParse(value).success
);
