import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";
import type { GatewayJsonValue } from "./gateway-json-contracts.ts";

export type SpaceImportStatus = "pending" | "running" | "completed" | "failed";

export interface SpaceImportResultDocument {
	id: string;
	kind: "page" | "database";
	title: string;
}

export interface SpaceImportRecord {
	byteSize: number;
	completedAt: number | null;
	createdAt: number;
	destinationKind: "auto" | "page" | "database" | "mixed";
	id: string;
	itemCount: number;
	message: string | null;
	resultDocuments: SpaceImportResultDocument[];
	sourceFormat: string;
	sourceName: string;
	/**
	 * `connector` imports (Notion, Google Drive, Confluence, GitHub, web URLs)
	 * carry the provider name in `sourceFormat`.
	 */
	sourceType: "file" | "composio" | "connector";
	spaceId: string;
	status: SpaceImportStatus;
	updatedAt: number;
}

interface ImportRecordWire {
	byte_size: number;
	completed_at?: number | null;
	created_at: number;
	destination_kind: SpaceImportRecord["destinationKind"];
	id: string;
	item_count: number;
	message?: string | null;
	result_documents?: SpaceImportResultDocument[];
	source_format: string;
	source_name: string;
	source_type: SpaceImportRecord["sourceType"];
	space_id: string;
	status: SpaceImportStatus;
	updated_at: number;
}

export interface ComposioImportRequest {
	action: string;
	arguments: Record<string, GatewayJsonValue>;
	destinationKind: "auto" | "page" | "database";
	title?: string;
	toolkit: string;
}

function fromWire(value: ImportRecordWire): SpaceImportRecord {
	return {
		id: value.id,
		spaceId: value.space_id,
		sourceType: value.source_type,
		sourceName: value.source_name,
		sourceFormat: value.source_format,
		destinationKind: value.destination_kind,
		status: value.status,
		resultDocuments: value.result_documents ?? [],
		itemCount: value.item_count,
		byteSize: value.byte_size,
		message: value.message ?? null,
		createdAt: value.created_at,
		updatedAt: value.updated_at,
		completedAt: value.completed_at ?? null,
	};
}

function fileDataBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () =>
			reject(reader.error ?? new Error("Could not read file"));
		reader.onload = () => {
			const result = reader.result;
			if (!isNativeText(result)) {
				reject(new Error("Could not encode file"));
				return;
			}
			resolve(result.slice(result.indexOf(",") + 1));
		};
		reader.readAsDataURL(file);
	});
}

const spaceImportResultDocumentResponseCodec: z.ZodType<SpaceImportResultDocument> =
	z
		.object({
			id: z.string(),
			kind: z.union([z.literal("page"), z.literal("database")]),
			title: z.string(),
		})
		.passthrough();
const importRecordWireResponseCodec: z.ZodType<ImportRecordWire> = z
	.object({
		byte_size: z.number(),
		completed_at: z.union([z.number(), z.null()]).optional(),
		created_at: z.number(),
		destination_kind: z.union([
			z.literal("auto"),
			z.literal("page"),
			z.literal("database"),
			z.literal("mixed"),
		]),
		id: z.string(),
		item_count: z.number(),
		message: z.union([z.string(), z.null()]).optional(),
		result_documents: z
			.array(spaceImportResultDocumentResponseCodec)
			.optional(),
		source_format: z.string(),
		source_name: z.string(),
		source_type: z.union([
			z.literal("file"),
			z.literal("composio"),
			z.literal("connector"),
		]),
		space_id: z.string(),
		status: z.union([
			z.literal("pending"),
			z.literal("running"),
			z.literal("completed"),
			z.literal("failed"),
		]),
		updated_at: z.number(),
	})
	.passthrough();
export async function fetchSpaceImports(
	target: ApiTarget,
	spaceId: string
): Promise<SpaceImportRecord[]> {
	const result = await request<{ imports?: ImportRecordWire[] }>(
		target,
		`/api/spaces/${encodeURIComponent(spaceId)}/imports`,
		{},
		z
			.object({ imports: z.array(importRecordWireResponseCodec).optional() })
			.passthrough()
	);
	return (result.imports ?? []).map(fromWire);
}

export async function createSpaceFileImport(
	target: ApiTarget,
	spaceId: string,
	file: File
): Promise<SpaceImportRecord> {
	const dataBase64 = await fileDataBase64(file);
	const result = await request<{ import: ImportRecordWire }>(
		target,
		`/api/spaces/${encodeURIComponent(spaceId)}/imports/files`,
		{
			method: "POST",
			body: {
				title: file.name,
				mime: file.type || "application/octet-stream",
				data_base64: dataBase64,
			},
		},
		z.object({ import: importRecordWireResponseCodec }).passthrough()
	);
	return fromWire(result.import);
}

export async function createSpaceComposioImport(
	target: ApiTarget,
	spaceId: string,
	input: ComposioImportRequest
): Promise<SpaceImportRecord> {
	const result = await request<{ import: ImportRecordWire }>(
		target,
		`/api/spaces/${encodeURIComponent(spaceId)}/imports/composio`,
		{
			method: "POST",
			body: {
				toolkit: input.toolkit,
				action: input.action,
				arguments: input.arguments,
				destination_kind: input.destinationKind,
				title: input.title,
			},
		},
		z.object({ import: importRecordWireResponseCodec }).passthrough()
	);
	return fromWire(result.import);
}
