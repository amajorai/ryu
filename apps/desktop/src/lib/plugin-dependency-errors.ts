import { z } from "zod";
import { pluginDocumentSchema } from "./api/plugin-wire-values.ts";
import { type DependencyError, dependencyErrorSchema } from "./api/plugins.ts";

const nativeErrorSchema = z.instanceof(Error);
const dependencyRecordSchema = z.custom<DependencyError>(
	(value) =>
		dependencyErrorSchema.safeParse(value).success &&
		pluginDocumentSchema.safeParse(value).success
);

/** Read Core's complete dependency refusal attached by the lifecycle client. */
export function dependencyErrorOf(
	value: Parameters<typeof nativeErrorSchema.parse>[0]
): DependencyError | null {
	const failure = nativeErrorSchema.safeParse(value);
	if (!(failure.success && "dependencyError" in failure.data)) {
		return null;
	}
	const dependency = dependencyRecordSchema.safeParse(
		failure.data.dependencyError
	);
	return dependency.success ? dependency.data : null;
}
