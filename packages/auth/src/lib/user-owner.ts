import { z } from "zod";

/** Native admin-plugin user fields written by Better Auth's Mongo adapter. */
export type { UserWithRole } from "better-auth/plugins/admin";

/** Only the organization plugin field consumed by these native session callers. */
interface NativeOrganizationField {
	readonly activeOrganizationId?: unknown;
}
const nativeOrganizationFieldSchema = z.custom<NativeOrganizationField>(
	(value) => {
		const boxed = new Object(value);
		return boxed === value;
	}
);
/** The plugin owns an optional string; Mongo legacy rows may retain null. */
export const activeOrganizationIdSchema = z.preprocess(
	(value) => value,
	nativeOrganizationFieldSchema
		.nullish()
		.transform((value) => value?.activeOrganizationId)
		.pipe(z.string().nullish())
);
