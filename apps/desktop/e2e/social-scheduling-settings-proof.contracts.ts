import { z } from "zod";
import type {
	SettingsResponse,
	Workspace,
} from "../../../apps-store/social/ui/src/types.ts";
import { pluginDocumentSchema } from "../src/lib/api/plugin-wire-values.ts";

// Native serde projections: models.rs Workspace/SocialSettings and settings.rs
// NodeSettingsView/QuietHours. Validate every field while retaining the raw JSON.
const workspaceFieldsSchema = z.object({
	created_at: z.number(),
	id: z.string(),
	name: z.string(),
}) satisfies z.ZodType<Workspace>;
export const socialWorkspaceProofSchema = z.custom<Workspace>((value) => {
	const parsed = pluginDocumentSchema.safeParse(value);
	return parsed.success && workspaceFieldsSchema.safeParse(parsed.data).success;
});

const credentialSourceSchema = z.enum(["env", "stored", "unset"]);
const platformSchema = z.enum([
	"x",
	"instagram",
	"tiktok",
	"youtube",
	"linkedin",
	"reddit",
	"facebook",
	"bluesky",
	"threads",
]);
const settingsFieldsSchema = z.object({
	node: z.object({
		bluesky_app_password_set: z.boolean(),
		bluesky_app_password_source: credentialSourceSchema,
		bluesky_handle: z.string().nullable(),
		default_platforms: z.array(platformSchema),
		default_workspace_id: z.string(),
		engagement_refresh_batch: z.number(),
		engagement_refresh_interval_secs: z.number(),
		inbox_poll_interval_secs: z.number(),
		inbox_polling_enabled: z.boolean(),
		quiet_hours: z.object({
			enabled: z.boolean(),
			end_hour: z.number(),
			start_hour: z.number(),
		}),
		threads_access_token_set: z.boolean(),
		threads_access_token_source: credentialSourceSchema,
		threads_user_id: z.string().nullable(),
		utc_offset_minutes: z.number(),
	}),
	settings: z.object({
		base_backoff_ms: z.number(),
		claim_lease_secs: z.number(),
		enforce_platform_limits: z.boolean(),
		max_attempts: z.number(),
		poll_interval_secs: z.number(),
		scheduler_enabled: z.boolean(),
		timezone: z.string(),
	}),
}) satisfies z.ZodType<SettingsResponse>;
export const socialSettingsProofSchema = z.custom<SettingsResponse>((value) => {
	const parsed = pluginDocumentSchema.safeParse(value);
	return parsed.success && settingsFieldsSchema.safeParse(parsed.data).success;
});
