import { z } from "zod";
import type { ApiTarget } from "./client.ts";
import { request } from "./client.ts";

export interface SpacePackageSummary {
	databases: number;
	embeddings: boolean;
	excluded: number;
	files: string[];
	name: string;
	pages: number;
	rows: number;
	version: string;
}

export interface SpacePackageExport {
	archiveBase64: string;
	contentType: string;
	filename: string;
	package: SpacePackageSummary;
}

export interface SpacePackageImport {
	databaseCount: number;
	needsReindex: boolean;
	pageCount: number;
	rowCount: number;
	spaceId: string;
	spaceName: string;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x80_00;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		const chunk = bytes.subarray(offset, offset + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function packageSummary(
	value: Partial<SpacePackageSummary> | undefined,
	name: string,
	version: string
): SpacePackageSummary {
	return {
		databases: value?.databases ?? 0,
		embeddings: value?.embeddings === true,
		excluded: value?.excluded ?? 0,
		files: value?.files ?? [],
		name: value?.name ?? name,
		pages: value?.pages ?? 0,
		rows: value?.rows ?? 0,
		version: value?.version ?? version,
	};
}

export async function exportSpacePackage(
	target: ApiTarget,
	spaceId: string
): Promise<SpacePackageExport> {
	const result = await request(
		target,
		"/api/spaces/".concat(encodeURIComponent(spaceId), "/export"),
		{ body: {}, method: "POST" },
		spacePackageExportWireResponseSchema
	);
	const filename = result.filename?.trim() || "space.ryupack";
	const archiveBase64 = result.archive_base64?.trim();
	if (!archiveBase64) {
		throw new Error("Core returned an empty Space package.");
	}
	return {
		archiveBase64,
		contentType: result.content_type || "application/zip",
		filename,
		package: packageSummary(result.package, filename, "1.0.0"),
	};
}

export async function importSpacePackage(
	target: ApiTarget,
	archive: Uint8Array,
	name?: string
): Promise<SpacePackageImport> {
	const result = await request(
		target,
		"/api/spaces/import",
		{
			body: {
				archive_base64: bytesToBase64(archive),
				...(name?.trim() ? { name: name.trim() } : undefined),
			},
			method: "POST",
		},
		spacePackageImportWireResponseSchema
	);
	const space = result.space;
	if (!(space?.space_id && space.space_name)) {
		throw new Error("Core returned an invalid imported Space.");
	}
	return {
		databaseCount: space.database_count ?? 0,
		needsReindex: space.needs_reindex !== false,
		pageCount: space.page_count ?? 0,
		rowCount: space.row_count ?? 0,
		spaceId: space.space_id,
		spaceName: space.space_name,
	};
}

export function downloadSpacePackage(
	exported: Pick<
		SpacePackageExport,
		"archiveBase64" | "contentType" | "filename"
	>
): void {
	const bytes = base64ToBytes(exported.archiveBase64);
	const archive = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(archive).set(bytes);
	const blob = new Blob([archive], {
		type: exported.contentType,
	});
	const url = URL.createObjectURL(blob);
	const link = window.document.createElement("a");
	link.href = url;
	link.download = exported.filename;
	window.document.body.append(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const partialResponseSchema = z
	.object({
		databases: z.number().optional(),
		embeddings: z.boolean().optional(),
		excluded: z.number().optional(),
		files: z.array(z.string()).optional(),
		name: z.string().optional(),
		pages: z.number().optional(),
		rows: z.number().optional(),
		version: z.string().optional(),
	})
	.passthrough();

const spacePackageExportWireResponseSchema = z
	.object({
		archive_base64: z.string().optional(),
		content_type: z.string().optional(),
		filename: z.string().optional(),
		package: partialResponseSchema.optional(),
	})
	.passthrough();

const response2SpaceSchema = z
	.object({
		database_count: z.number().optional(),
		needs_reindex: z.boolean().optional(),
		page_count: z.number().optional(),
		row_count: z.number().optional(),
		space_id: z.string().optional(),
		space_name: z.string().optional(),
	})
	.passthrough();

const spacePackageImportWireResponseSchema = z
	.object({ space: response2SpaceSchema.optional() })
	.passthrough();
