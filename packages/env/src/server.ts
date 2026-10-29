import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { billingServerEnv } from "./server-schema/billing";
import { identityServerEnv } from "./server-schema/identity";
import { operationsServerEnv } from "./server-schema/operations";
import { servicesServerEnv } from "./server-schema/services";

// The schema is split by area under ./server-schema so each file stays small;
// keys must stay unique across the parts (a later spread would shadow one).
export const env = createEnv({
	server: {
		...identityServerEnv,
		...billingServerEnv,
		...servicesServerEnv,
		...operationsServerEnv,
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
	// Skip validation during builds (e.g. the web Docker build imports server
	// modules but has no server secrets). Set SKIP_ENV_VALIDATION=1 at build
	// time only — runtime containers leave it unset so startup still validates.
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});

if (
	!process.env.SKIP_ENV_VALIDATION &&
	env.NODE_ENV === "production" &&
	!env.RYU_DB_MASTER_KEY
) {
	throw new Error(
		"RYU_DB_MASTER_KEY is required in production so sensitive control-plane fields are encrypted at rest."
	);
}
