import { z } from "zod";
import type { AgentLifecyclePreview } from "./agents.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

// Complete catalog install/uninstall preview fields emitted by Core server/mod.rs.
// Optional fields retain the original four-field public preview compatibility.
const previewFieldsSchema = z.object({
	action: z.enum(["install", "uninstall"]),
	dryRun: z.literal(true),
	id: z.string(),
	success: z.boolean(),
	alreadyInstalled: z.boolean().optional(),
	name: z.string().optional(),
	ok: z.boolean().optional(),
	wouldInstall: z.boolean().optional(),
	wouldUninstall: z.boolean().optional(),
	writes: z.array(z.string()).optional(),
});
export const agentLifecyclePreviewSchema = z.custom<AgentLifecyclePreview>(
	(value) =>
		previewFieldsSchema.safeParse(value).success &&
		gatewayJsonValueSchema.safeParse(value).success
);
