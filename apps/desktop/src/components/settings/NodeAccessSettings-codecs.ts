import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const pairingConstraintsResponseCodec = z
	.object({
		agent_id: z.string().optional(),
		client_id: z.string().optional(),
		node_id: z.string().optional(),
		org_id: z.string().optional(),
		plugin_id: z.string().optional(),
		resource_id: z.string().optional(),
		subject_id: z.string().optional(),
		team_id: z.string().optional(),
		tool_name: z.string().optional(),
	})
	.catchall(gatewayJsonValueSchema);
const pairingRequestResponseCodec = z
	.object({
		client_name: z.string(),
		created_at: z.number(),
		requested_constraints: pairingConstraintsResponseCodec.optional(),
		requested_expires_at: z.union([z.number(), z.null()]).optional(),
		requested_scopes: z.array(z.string()).optional(),
		user_code: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
export const responseCodec1 = z
	.object({ requests: z.array(pairingRequestResponseCodec) })
	.catchall(gatewayJsonValueSchema);
const pairedClientResponseCodec = z
	.object({
		active: z.boolean().optional(),
		constraints: pairingConstraintsResponseCodec.optional(),
		created_at: z.number(),
		expires_at: z.union([z.number(), z.null()]).optional(),
		granted_scopes: z.array(z.string()).optional(),
		id: z.string(),
		last_seen: z.number(),
		name: z.string(),
		revoked_at: z.union([z.number(), z.null()]).optional(),
		schema_version: z.number().optional(),
	})
	.catchall(gatewayJsonValueSchema);
export const responseCodec2 = z
	.object({ clients: z.array(pairedClientResponseCodec) })
	.catchall(gatewayJsonValueSchema);
export const responseCodec3 = gatewayJsonValueSchema.optional();
export const responseCodec4 = gatewayJsonValueSchema.optional();
export const responseCodec5 = z
	.object({ message: z.string(), restart_required: z.boolean() })
	.catchall(gatewayJsonValueSchema);
