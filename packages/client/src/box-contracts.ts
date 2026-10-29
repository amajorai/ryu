import { z } from "zod";
import type {
	Box,
	BoxAccessToken,
	BoxDesktop,
	BoxEvent,
	BoxExecResult,
	BoxFileEntry,
	BoxLimits,
	BoxPlacement,
	BoxPreview,
	BoxProcess,
	BoxPromptRun,
	BoxSnapshot,
	BoxSsh,
	BoxUsage,
} from "./box.ts";
import { wireJsonRecordSchema, wireNumberSchema } from "./wire-json.ts";

const text = z.string();
const nullableText = text.nullable();
const strings = z.array(text);
const boxSize = z.enum(["small", "default", "large"]);
const network = z.enum(["none", "egress", "allowlist"]);
export const processStatusSchema = z.enum([
	"exited",
	"killed",
	"running",
	"timed_out",
]);
const placementValidation: z.ZodType<BoxPlacement> = z.object({
	isolation: z.enum(["container", "gvisor", "host", "microvm", "vm"]),
	location: text,
	provider: z.enum(["hetzner", "vultr", "digitalocean", "overflow", "local"]),
	serverType: text,
	tier: z.enum(["parked", "hetzner", "pool", "overflow", "fallback", "local"]),
});
const desktopValidation: z.ZodType<BoxDesktop> = z.object({
	height: wireNumberSchema,
	ready: z.boolean(),
	viewers: wireNumberSchema,
	width: wireNumberSchema,
});
const boxValidation: z.ZodType<Box> = z.object({
	allowedHosts: strings,
	billing: z
		.object({
			minimumWaived: z.boolean(),
			paidHourEndsAt: nullableText,
			waiver: text.optional(),
		})
		.optional(),
	createdAt: text,
	desktop: desktopValidation.optional(),
	driver: text,
	envNames: strings,
	id: text,
	image: text,
	lastError: nullableText,
	name: text,
	network,
	placement: placementValidation.optional(),
	repo: z.object({ branch: nullableText, url: text }).nullable(),
	runningSince: nullableText.optional(),
	secrets: strings,
	size: boxSize,
	snapshotId: nullableText,
	status: z.enum([
		"provisioning",
		"ready",
		"running",
		"stopping",
		"stopped",
		"error",
		"deleted",
	]),
	stoppedAt: nullableText,
	ttlSeconds: wireNumberSchema.nullable(),
	updatedAt: text,
});
export const boxSchema = z.custom<Box>(
	(value) => boxValidation.safeParse(value).success
);
const processValidation: z.ZodType<BoxProcess> = z.object({
	args: strings,
	background: z.boolean(),
	boxId: text,
	command: text,
	cwd: text,
	durationMs: wireNumberSchema.nullable(),
	endedAt: nullableText,
	exitCode: wireNumberSchema.nullable(),
	id: text,
	kind: z.enum(["command", "prompt", "setup", "ssh", "terminal"]),
	outputTruncated: z.boolean(),
	startedAt: text,
	status: processStatusSchema,
});
export const boxProcessSchema = z.custom<BoxProcess>(
	(value) => processValidation.safeParse(value).success
);
const eventValidation: z.ZodType<BoxEvent> = z.object({
	createdAt: text,
	id: wireNumberSchema,
	payload: wireJsonRecordSchema,
	type: text,
});
export const boxEventSchema = z.custom<BoxEvent>(
	(value) => eventValidation.safeParse(value).success
);
const resultValidation: z.ZodType<BoxExecResult> = z.object({
	durationMs: wireNumberSchema,
	exitCode: wireNumberSchema,
	stderr: text,
	stdout: text,
});
export const boxResultSchema = z.custom<BoxExecResult>(
	(value) => resultValidation.safeParse(value).success
);
const fileValidation: z.ZodType<BoxFileEntry> = z.object({
	mode: text,
	modifiedAt: text,
	name: text,
	path: text,
	size: wireNumberSchema,
	type: z.enum(["directory", "file", "other", "symlink"]),
});
export const boxFileSchema = z.custom<BoxFileEntry>(
	(value) => fileValidation.safeParse(value).success
);
const previewValidation: z.ZodType<BoxPreview> = z.object({
	createdAt: text,
	port: wireNumberSchema,
	token: text,
	url: text,
	visibility: z.enum(["private", "public"]),
});
export const boxPreviewSchema = z.custom<BoxPreview>(
	(value) => previewValidation.safeParse(value).success
);
const tokenValidation: z.ZodType<BoxAccessToken> = z.object({
	expiresAt: text,
	token: text,
	url: text,
});
export const boxTokenSchema = z.custom<BoxAccessToken>(
	(value) => tokenValidation.safeParse(value).success
);
/**
 * A desktop token; `url`, when present, must be absolute (ws(s) or http(s))
 * and never carries the token, which travels only in `protocols`.
 */
const desktopTokenValidation = z.object({
	expiresAt: text,
	protocols: z.array(text).min(1),
	token: text,
	url: text
		.refine((value) => {
			try {
				return ["ws:", "wss:", "http:", "https:"].includes(
					new URL(value).protocol
				);
			} catch {
				return false;
			}
		}, "url must be absolute")
		.refine(
			(value) => !value.includes("access_token="),
			"url must not carry the token"
		)
		.optional(),
});
export const boxDesktopTokenSchema = z.custom<
	z.infer<typeof desktopTokenValidation>
>((value) => desktopTokenValidation.safeParse(value).success);
const limitsValidation: z.ZodType<BoxLimits> = z.object({
	maxResourceUnits: wireNumberSchema,
	maxRunning: wireNumberSchema,
	maxStored: wireNumberSchema,
	resourceUnits: wireNumberSchema,
	running: wireNumberSchema,
	stored: wireNumberSchema,
});
export const boxLimitsSchema = z.custom<BoxLimits>(
	(value) => limitsValidation.safeParse(value).success
);
const sshValidation: z.ZodType<BoxSsh> = z.object({
	host: text,
	port: wireNumberSchema,
	proxyCommand: text,
	tunnelUrl: text,
	user: text,
});
export const boxSshSchema = z.custom<BoxSsh>(
	(value) => sshValidation.safeParse(value).success
);
const snapshotValidation: z.ZodType<BoxSnapshot> = z.object({
	boxId: text,
	createdAt: text,
	id: text,
	name: text,
	network,
	size: boxSize,
});
export const boxSnapshotSchema = z.custom<BoxSnapshot>(
	(value) => snapshotValidation.safeParse(value).success
);
const promptValidation = z.object({
	createdAt: text,
	execution: z.enum(["managed", "worker"]),
	id: text,
	processId: nullableText,
	provider: z.enum(["codex", "cursor", "claude", "claude-code", "opencode"]),
	status: text,
	// Result fields; older Box services omit them, so they default to null.
	completedAt: nullableText.default(null),
	exitCode: wireNumberSchema.nullable().default(null),
	reason: z
		.enum(["box_destroyed", "canceled", "service_restarted", "timeout"])
		.nullable()
		.default(null),
	summary: nullableText.default(null),
}) satisfies z.ZodType<BoxPromptRun, unknown>;
export const boxPromptSchema = promptValidation;
const usageValidation: z.ZodType<BoxUsage> = z.object({
	boxes: z.array(
		z.object({
			billableSeconds: wireNumberSchema.optional(),
			boxId: text,
			resourceUnitSeconds: wireNumberSchema,
			seconds: wireNumberSchema,
			size: boxSize.optional(),
			stateByteSeconds: wireNumberSchema.optional(),
			stateBytes: wireNumberSchema.optional(),
			storageAllowanceGib: wireNumberSchema.optional(),
			storageSeconds: wireNumberSchema.optional(),
		})
	),
	from: text,
	snapshots: z
		.array(
			z.object({
				sizeBytes: wireNumberSchema,
				snapshotId: text,
				storageSeconds: wireNumberSchema,
			})
		)
		.optional(),
	to: text,
	totals: z.object({
		billableSeconds: wireNumberSchema.optional(),
		resourceUnitSeconds: wireNumberSchema,
		seconds: wireNumberSchema,
	}),
});
export const boxUsageSchema = z.custom<BoxUsage>(
	(value) => usageValidation.safeParse(value).success
);
const boxOutputValidation = z.object({
	data: text,
	seq: wireNumberSchema,
	stream: z.enum(["stderr", "stdout"]),
});
export const boxOutputSchema = z.custom<z.infer<typeof boxOutputValidation>>(
	(value) => boxOutputValidation.safeParse(value).success
);
const boxLogsValidation = z.object({
	chunks: z.array(boxOutputSchema),
	process: boxProcessSchema,
});
export const boxLogsSchema = z.custom<z.infer<typeof boxLogsValidation>>(
	(value) => boxLogsValidation.safeParse(value).success
);
const boxSecretValidation = z.object({ name: text, updatedAt: text });
export const boxExitSchema = z.object({
	durationMs: wireNumberSchema.nullish(),
	exitCode: wireNumberSchema.nullish(),
	status: processStatusSchema,
});

export const boxSecretSchema = z.custom<z.infer<typeof boxSecretValidation>>(
	(value) => boxSecretValidation.safeParse(value).success
);
