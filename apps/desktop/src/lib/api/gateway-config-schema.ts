import { z } from "zod";
import { gatewayConfigOverlaysShape } from "./gateway-config-schema-overlays.ts";
import { gatewayConfigPolicyShape } from "./gateway-config-schema-policy.ts";
import { gatewayConfigProvidersShape } from "./gateway-config-schema-providers.ts";
import { gatewayConfigRoutingShape } from "./gateway-config-schema-routing.ts";
import { retainValidatedResponse } from "./gateway-status-response-contracts.ts";

export const gatewayConfigResponseSchema = retainValidatedResponse(
	z
		.object({
			...gatewayConfigPolicyShape,
			...gatewayConfigOverlaysShape,
			...gatewayConfigProvidersShape,
			...gatewayConfigRoutingShape,
		})
		.passthrough()
);
