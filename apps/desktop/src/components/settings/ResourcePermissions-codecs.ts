import { z } from "zod";
import type {
	DeclaredLevel,
	Overwrite,
	PrincipalDirectory,
	Vocabulary,
} from "./ResourcePermissions-types.ts";

export const declaredLevelResponseCodec: z.ZodType<DeclaredLevel> = z
	.object({
		description: z.string(),
		id: z.string(),
		implies: z.array(z.string()),
		label: z.string(),
		plugin_id: z.string(),
	})
	.passthrough();
export const vocabularyResponseCodec: z.ZodType<Vocabulary> = z
	.object({
		collisions: z.array(z.string()),
		declared: z.array(declaredLevelResponseCodec),
		kernel: z.array(z.string()),
	})
	.passthrough();
export const overwriteResponseCodec: z.ZodType<Overwrite> = z
	.object({
		allow: z.array(z.string()),
		deny: z.array(z.string()),
		target_id: z.string(),
		target_type: z.union([
			z.literal("org"),
			z.literal("team"),
			z.literal("role"),
			z.literal("member"),
		]),
	})
	.passthrough();
export const principalDirectoryResponseCodec: z.ZodType<PrincipalDirectory> = z
	.object({
		kinds: z.array(z.string()).optional(),
		members: z.array(
			z
				.object({
					email: z.union([z.string(), z.null()]),
					id: z.string(),
					name: z.string(),
				})
				.passthrough()
		),
		org_id: z.union([z.string(), z.null()]).optional(),
		roles: z.array(
			z.object({ id: z.string(), label: z.string() }).passthrough()
		),
		teams: z.array(
			z.object({ id: z.string(), name: z.string() }).passthrough()
		),
	})
	.passthrough();
