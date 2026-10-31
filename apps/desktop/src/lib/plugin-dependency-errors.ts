import { z } from "zod";
import { pluginDocumentSchema } from "./api/plugin-wire-values.ts";
import {
	type AppLifecycleError,
	type DependencyError,
	dependencyErrorSchema,
} from "./api/plugins.ts";

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

type GatewayRefusal = Pick<
	AppLifecycleError,
	"deniedGrants" | "gatewayUnreachable" | "grantsDenied" | "unreachableReason"
>;
// Every field is required: an error that does not carry the structured detail
// (another client's shape) keeps its own message rather than a vaguer sentence.
const gatewayRefusalSchema = z.object({
	deniedGrants: z.string().nullable(),
	gatewayUnreachable: z.boolean(),
	grantsDenied: z.boolean(),
	unreachableReason: z.string().nullable(),
});

/** Read the Gateway refusal fields (denied grants / fail-closed unreachable)
 *  attached by the lifecycle client, or `null` when the failure is neither. */
export function gatewayRefusalOf(
	value: Parameters<typeof nativeErrorSchema.parse>[0]
): GatewayRefusal | null {
	const failure = nativeErrorSchema.safeParse(value);
	if (!failure.success) {
		return null;
	}
	const refusal = gatewayRefusalSchema.safeParse({ ...failure.data });
	if (
		!(
			refusal.success &&
			(refusal.data.grantsDenied || refusal.data.gatewayUnreachable)
		)
	) {
		return null;
	}
	return refusal.data;
}
