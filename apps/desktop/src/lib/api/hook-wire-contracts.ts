import { type RyuJsonValue, rpcJsonResponseSchema } from "@ryu/app-host/rpc";
import { z } from "zod";
import type { HookPolicyOverride } from "./governance.ts";
import type { HookHandlerSummary, HookInventoryItem } from "./hooks.ts";

type HookMatcher = Record<string, RyuJsonValue>;
const matcherInputSchema = z.record(z.string(), z.unknown());
export const hookMatcherSchema = z.custom<HookMatcher>(
	(value) =>
		rpcJsonResponseSchema.safeParse(value).success &&
		matcherInputSchema.safeParse(value).success
);
const optionalBooleanSchema = z.boolean().optional().catch(undefined);
const overrideSchema = z
	.object({ enabled: optionalBooleanSchema, trusted: optionalBooleanSchema })
	.transform((value): HookPolicyOverride => {
		const policy: HookPolicyOverride = {};
		if (value.enabled !== undefined) {
			policy.enabled = value.enabled;
		}
		if (value.trusted !== undefined) {
			policy.trusted = value.trusted;
		}
		return policy;
	})
	.optional()
	.catch(undefined);
const localOverridesSchema = z
	.object({ node: overrideSchema, user: overrideSchema })
	.transform((value): HookInventoryItem["localOverrides"] => {
		const overrides: HookInventoryItem["localOverrides"] = {};
		if (value.node) {
			overrides.node = value.node;
		}
		if (value.user) {
			overrides.user = value.user;
		}
		return overrides;
	})
	.catch({});
const handlerSchema = z
	.object({
		kind: z.enum(["command", "sandbox_js", "unknown"]),
		display: z.string(),
		path: z.string().optional().catch(undefined),
	})
	.transform((value): HookHandlerSummary => {
		const handler: HookHandlerSummary = {
			display: value.display,
			kind: value.kind,
		};
		if (value.path !== undefined) {
			handler.path = value.path;
		}
		return handler;
	});
export const hookInventoryItemSchema = z
	.object({
		source: z.enum(["config", "plugin"]),
		priority: z.number().refine(Number.isInteger),
		effectiveEnabled: z.boolean(),
		enabled: z.boolean(),
		handler: handlerSchema,
		hookKey: z.string(),
		id: z.string(),
		localOverrides: localOverridesSchema,
		ownerId: z.string(),
		ownerName: z.string(),
		phase: z.string(),
		pluginEnabled: z.boolean().catch(true),
		reviewRequired: z.boolean(),
		trusted: z.boolean(),
		matcher: hookMatcherSchema.optional().catch(undefined),
	})
	.transform((value): HookInventoryItem => {
		const hook: HookInventoryItem = {
			effectiveEnabled: value.effectiveEnabled,
			enabled: value.enabled,
			handler: value.handler,
			hookKey: value.hookKey,
			id: value.id,
			localOverrides: value.localOverrides,
			ownerId: value.ownerId,
			ownerName: value.ownerName,
			phase: value.phase,
			pluginEnabled: value.pluginEnabled,
			priority: value.priority,
			reviewRequired: value.reviewRequired,
			source: value.source,
			trusted: value.trusted,
		};
		if (value.matcher) {
			hook.matcher = value.matcher;
		}
		return hook;
	});
export const hookInventorySchema = z.object({
	hooks: z.array(hookInventoryItemSchema),
});
