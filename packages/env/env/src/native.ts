import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	clientPrefix: "EXPO_PUBLIC_",
	client: {
		EXPO_PUBLIC_SERVER_URL: z.url(),
		EXPO_PUBLIC_WEB_URL: z.url(),
		// Ryu Core — the converged chat backend (default :7980). A physical device
		// cannot reach the host's localhost, so this must point at a LAN/tunnel URL
		// in real use; the default only works on simulators/emulators on the host.
		EXPO_PUBLIC_CORE_URL: z.url().default("http://localhost:7980"),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});
