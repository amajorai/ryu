// Login import (`/api/vault/login-imports`): read a password export (CSV) into
// typed login items. The file's text goes to the user's own node in the
// request body and nowhere else. A preview saves nothing and no reply carries
// a password, an authenticator seed or a note.

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

/**
 * Largest file the dialog sends. Core accepts a 4 MiB body; JSON escaping
 * makes the body a little larger than the file.
 */
export const LOGIN_IMPORT_MAX_BYTES = 3 * 1024 * 1024;

const formatSchema = z.enum([
	"chrome",
	"firefox",
	"safari",
	"bitwarden",
	"1password",
]);

const existingSchema = z.object({
	id: z.string(),
	key: z.string(),
	version: z.number(),
});

const previewRowSchema = z.object({
	existing: existingSchema.optional(),
	hasNotes: z.boolean(),
	hasTotp: z.boolean(),
	host: z.string().optional(),
	problem: z.string().optional(),
	row: z.number(),
	site: z.string().optional(),
	status: z.enum(["new", "duplicate", "repeated", "invalid"]),
	title: z.string().optional(),
	totpDropped: z.boolean(),
	username: z.string().optional(),
});

const previewSchema = z.object({
	counts: z.object({
		duplicate: z.number(),
		invalid: z.number(),
		new: z.number(),
		repeated: z.number(),
		total: z.number(),
	}),
	environment: z.string(),
	format: formatSchema,
	path: z.string(),
	rows: z.array(previewRowSchema),
});

const resultSchema = z.object({
	created: z.number(),
	replaced: z.number(),
	rows: z.array(
		z.object({
			key: z.string().optional(),
			outcome: z.enum([
				"created",
				"replaced",
				"skipped_duplicate",
				"conflict",
				"denied",
				"invalid",
			]),
			row: z.number(),
		})
	),
	skipped: z.number(),
});

const previewReply = z.object({ preview: previewSchema });
const resultReply = z.object({ result: resultSchema });

export type LoginImportFormat = z.infer<typeof formatSchema>;
export type LoginImportPreview = z.infer<typeof previewSchema>;
export type LoginImportPreviewRow = z.infer<typeof previewRowSchema>;
export type LoginImportResult = z.infer<typeof resultSchema>;

/** Where the logins go: an environment and a folder of it. */
export interface LoginImportLocation {
	environment?: string;
	path?: string;
}

/** The user's choice to replace the saved login a duplicate matches. */
export interface LoginImportReplace {
	expectedId: string;
	expectedVersion: number;
	row: number;
}

/** What importing `csv` would do. Saves nothing. */
export async function previewLoginImport(
	target: ApiTarget,
	csv: string,
	location: LoginImportLocation = {}
): Promise<LoginImportPreview> {
	const reply = await request(
		target,
		"/api/vault/login-imports/preview",
		{ method: "POST", body: { csv, ...location } },
		previewReply
	);
	return reply.preview;
}

/**
 * Save the records in `rows` as new logins and replace the saved logins in
 * `replace`. A record in `rows` that matches a saved login is skipped.
 */
export async function applyLoginImport(
	target: ApiTarget,
	input: LoginImportLocation & {
		csv: string;
		replace: LoginImportReplace[];
		rows: number[];
	}
): Promise<LoginImportResult> {
	const reply = await request(
		target,
		"/api/vault/login-imports",
		{ method: "POST", body: input },
		resultReply
	);
	return reply.result;
}
