// Complete native mesh status shared by System and Mesh without an import cycle.
import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";

function systemResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const systemText = z.string();
const systemOptionalText = systemText.nullable().optional();
const systemPeerSchema = systemResponse(
	z.object({
		name: systemText.optional(),
		host_or_dns: systemText.optional(),
		magic_dns_name: systemText.optional(),
		tailscale_ips: z.array(systemText).optional(),
		online: z.boolean().optional(),
		os: systemText.optional(),
	})
);
export const meshStatusResponseSchema = systemResponse(
	z.object({
		enabled: z.boolean().optional(),
		reachable: z.boolean().optional(),
		up: z.boolean().optional(),
		backend: systemOptionalText,
		backend_state: systemText.optional(),
		control_server: systemOptionalText,
		magic_dns_name: systemOptionalText,
		tailscale_ips: z.array(systemText).optional(),
		tailcat_address: systemOptionalText,
		cloudflaredUrl: systemOptionalText,
		peers: z.array(systemPeerSchema).optional(),
		webhook_ingress_mode: systemOptionalText,
	})
);
