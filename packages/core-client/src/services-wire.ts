import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";

// Complete native publishers: server/mod.rs sidecar/setup lifecycle, sandbox
// status and dependency check/install. Predicate admission retains the raw tree,
// including future metadata and dictionary entry references.
function nativeServiceResponse<
	S extends z.ZodObject | z.ZodUnion | z.ZodRecord,
>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const dependenciesFields = z
	.object({
		git: z.boolean(),
		rust: z.boolean(),
		npm: z.boolean(),
		python: z.boolean(),
	})
	.catchall(z.boolean());
const errorFields = z.object({ success: z.literal(false), error: z.string() });
export const dependenciesCheckResponseSchema = nativeServiceResponse(
	z.union([
		z.object({
			dependencies: dependenciesFields,
			all_installed: z.boolean(),
			success: z.never().optional(),
			error: z.never().optional(),
		}),
		errorFields.extend({
			dependencies: z.never().optional(),
			all_installed: z.never().optional(),
		}),
	])
);
const dependencyInstallResultFields = z.union([
	z.object({
		status: z.enum(["installed", "already_installed"]),
		success: z.literal(true),
		error: z.never().optional(),
	}),
	z.object({
		status: z.literal("failed"),
		success: z.literal(false),
		error: z.string(),
	}),
]);
export const dependencyInstallResultsSchema = nativeServiceResponse(
	z.record(z.string(), dependencyInstallResultFields)
);
export type DependencyInstallResults = z.output<
	typeof dependencyInstallResultsSchema
>;
export const dependenciesInstallResponseSchema = nativeServiceResponse(
	z.object({
		success: z.boolean(),
		results: dependencyInstallResultsSchema,
		dependencies: dependenciesFields,
		all_installed: z.boolean(),
	})
);
export const sandboxStatusResponseSchema = nativeServiceResponse(
	z.object({
		enabled: z.boolean(),
		available: z.boolean(),
		// Docker probing was additive; older Core status replies omit this whole slot.
		docker: z
			.object({ available: z.boolean(), reason: z.string().nullable() })
			.optional(),
	})
);
const successFields = z.object({
	success: z.literal(true),
	error: z.never().optional(),
});
const httpErrorFields = z.object({
	error: z.string(),
	success: z.never().optional(),
});
export const sidecarActionResponseSchema = nativeServiceResponse(
	z.union([successFields, errorFields, httpErrorFields])
);
export const setupInstallResponseSchema = nativeServiceResponse(
	z.union([
		successFields.extend({ forced: z.boolean(), message: z.string() }),
		successFields.extend({
			forced: z.boolean(),
			version: z.string(),
			path: z.string(),
		}),
		errorFields.extend({ forced: z.boolean().optional() }),
		successFields.extend({
			dryRun: z.literal(true),
			action: z.literal("install"),
			name: z.string(),
			supported: z.boolean(),
			installed: z.boolean(),
			force: z.boolean(),
			version: z.string().nullable(),
			writes: z.array(z.string()),
		}),
		httpErrorFields,
	])
);
export const setupUninstallResponseSchema = nativeServiceResponse(
	z.union([
		successFields.extend({ message: z.string() }),
		errorFields,
		successFields.extend({
			dryRun: z.literal(true),
			action: z.literal("uninstall"),
			name: z.string(),
			removeData: z.boolean(),
			installed: z.boolean(),
			writes: z.array(z.string()),
		}),
		httpErrorFields,
	])
);
export type ServiceActionResponse = z.output<
	| typeof sidecarActionResponseSchema
	| typeof setupInstallResponseSchema
	| typeof setupUninstallResponseSchema
>;
