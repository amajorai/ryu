import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// apps/desktop/src/lib/api/data-path.ts
//
// Typed client for Core's data-folder ("Storage") endpoints. All path logic lives
// in Core (`crate::data_path`); the desktop only reads state, validates a target,
// and triggers the point-only switch / export. Copy-migrate and import run as the
// offline `ryu-core data-path` subcommand orchestrated by Tauri commands (see
// `migrate_data_folder` / `import_data_folder` in src-tauri).

import { type ApiTarget, request } from "./client.ts";

export interface DataPathInfo {
	current: string;
	default: string;
	free_space_bytes: number;
	is_custom: boolean;
	size_bytes: number;
}

export interface ValidateResult {
	error?: string;
	ok: boolean;
	source_size_bytes: number;
	target_free_bytes: number;
}

/** Current data-folder location, default, size and free space. */
export function getDataPath(target: ApiTarget): Promise<DataPathInfo> {
	return request<DataPathInfo>(
		target,
		"/api/data-path",
		undefined,
		dataPathInfoResponseCodec
	);
}

/** Validate a candidate target folder for a copy-relocation. */
export function validateDataPath(
	target: ApiTarget,
	path: string
): Promise<ValidateResult> {
	return request<ValidateResult>(
		target,
		"/api/data-path/validate",
		{
			method: "POST",
			body: { path },
		},
		validateResultResponseCodec
	);
}

/** Point-only switch (no copy): old data stays put, new folder starts fresh. */
export function switchDataPath(
	target: ApiTarget,
	path: string
): Promise<{ ok: boolean; restart_required?: boolean; error?: string }> {
	return request(
		target,
		"/api/data-path/switch",
		{
			method: "POST",
			body: { path },
		},
		responseCodec1
	);
}

/** Revert to the default `~/.ryu` (point-only). */
export function resetDataPath(
	target: ApiTarget
): Promise<{ ok: boolean; restart_required?: boolean; error?: string }> {
	return request(
		target,
		"/api/data-path/reset",
		{ method: "POST" },
		responseCodec2
	);
}

/**
 * Zip the current data folder to `out`, encrypted under `passphrase` (runs
 * online, no restart). Core refuses a passphrase shorter than 12 characters.
 */
export function exportDataPath(
	target: ApiTarget,
	out: string,
	passphrase: string
): Promise<{ ok: boolean; bytes?: number; error?: string }> {
	return request(
		target,
		"/api/data-path/export",
		{
			method: "POST",
			body: { out, passphrase },
		},
		responseCodec3
	);
}

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const dataPathInfoResponseCodec = z
	.object({
		current: z.string(),
		default: z.string(),
		free_space_bytes: z.number(),
		is_custom: z.boolean(),
		size_bytes: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
const validateResultResponseCodec = z
	.object({
		error: z.string().optional(),
		ok: z.boolean(),
		source_size_bytes: z.number(),
		target_free_bytes: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec1 = z
	.object({
		ok: z.boolean(),
		restart_required: z.boolean().optional(),
		error: z.string().optional(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec2 = z
	.object({
		ok: z.boolean(),
		restart_required: z.boolean().optional(),
		error: z.string().optional(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec3 = z
	.object({
		ok: z.boolean(),
		bytes: z.number().optional(),
		error: z.string().optional(),
	})
	.catchall(gatewayJsonValueSchema);
