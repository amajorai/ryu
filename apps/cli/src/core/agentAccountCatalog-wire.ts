// Core wire codecs for the agent account catalog (see ./agentAccountCatalog.ts).

import { z } from "zod";

// ── Wire codecs (loose: unknown fields pass through) ────────────────────────

export const composioStatusSchema = z.looseObject({
	configured: z.boolean().optional(),
});
export const connectionWireSchema = z.looseObject({
	active: z.boolean().optional(),
	id: z.string().optional(),
	status: z.string().optional(),
	toolkit: z.string().optional(),
});
export const connectionsSchema = z.looseObject({
	configured: z.boolean().optional(),
	data: z.array(connectionWireSchema).optional(),
});
export const pluginsSchema = z.looseObject({
	apps: z
		.array(
			z.looseObject({
				enabled: z.boolean().optional(),
				id: z.string(),
				mcp_servers: z
					.record(
						z.string(),
						z.looseObject({
							auth: z.looseObject({ type: z.string().optional() }).nullish(),
							url: z.string().nullish(),
						})
					)
					.nullish(),
				name: z.string().optional(),
				runnables: z
					.array(
						z.looseObject({
							config: z.unknown().optional(),
							kind: z.string().optional(),
						})
					)
					.nullish(),
			})
		)
		.optional(),
});
export const mcpOAuthSchema = z.looseObject({
	servers: z
		.array(
			z.looseObject({
				connections: z
					.array(
						z.looseObject({
							account_label: z.string().nullish(),
							profile_id: z.string(),
							status: z.string().optional(),
						})
					)
					.optional(),
				server_name: z.string(),
			})
		)
		.optional(),
});
export const mcpServersSchema = z.looseObject({
	servers: z
		.array(
			z.looseObject({
				name: z.string(),
				owner_plugin_id: z.string().nullish(),
				saved_key_account: z.string().nullish(),
			})
		)
		.optional(),
});
export const providerViewSchema = z.looseObject({
	api_key: z.string().nullish(),
	api_key_count: z.number().optional(),
});
export const gatewayConfigSchema = z.looseObject({
	providers: z
		.looseObject({
			compatible: z.record(z.string(), providerViewSchema).nullish(),
			core: z.looseObject({ has_token: z.boolean().optional() }).nullish(),
			genai: z
				.looseObject({
					gemini_account_count: z.number().optional(),
					keys: z.array(z.string()).optional(),
					sdk_providers: z
						.array(
							z.looseObject({
								auth_kind: z.string().optional(),
								configured: z.boolean().optional(),
								label: z.string(),
								provider_id: z.string(),
							})
						)
						.optional(),
				})
				.nullish(),
		})
		.nullish(),
});
export const vaultAccountsSchema = z.looseObject({
	accounts: z
		.array(
			z.looseObject({
				email: z.string().nullish(),
				has_totp: z.boolean().optional(),
				host: z.string().optional(),
				id: z.string(),
				label: z.string().nullish(),
				site: z.string().optional(),
				username: z.string().nullish(),
			})
		)
		.optional(),
});
export const launchCheckSchema = z.looseObject({
	vendor_provider: z.string().nullish(),
});

export type GatewayProvidersWire = NonNullable<
	z.output<typeof gatewayConfigSchema>["providers"]
>;
export type PluginWire = NonNullable<
	z.output<typeof pluginsSchema>["apps"]
>[number];
export type McpServerWire = NonNullable<
	z.output<typeof mcpServersSchema>["servers"]
>[number];
