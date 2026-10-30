import { asGlyphValue } from "@ryu/ui/components/glyph.ts";
import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";

// apps/desktop/src/lib/api/spaces-response-codecs.ts
//
// Response codecs for the Spaces client. Split out of `spaces.ts`, which re-exports
// everything public here so its import path stays stable.

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
export const responseCodec1 = z
	.object({ id: z.string(), retrieval_mode: z.string().optional() })
	.catchall(gatewayJsonValueSchema);
export const responseCodec2 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
export const responseCodec3 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
export const responseCodec4 = z
	.object({ removed: z.boolean().optional() })
	.catchall(gatewayJsonValueSchema);
export const responseCodec5 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
export const responseCodec6 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
const spaceLexicalHitWireResponseCodec = z
	.object({
		created_at: z.number(),
		document_id: z.string(),
		snippet: z.string(),
		space_id: z.string(),
		space_name: z.string(),
		title: z.string(),
		updated_at: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
export const responseCodec7 = z
	.object({ hits: z.array(spaceLexicalHitWireResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);
export const responseCodec8 = z
	.object({ document_id: z.string() })
	.catchall(gatewayJsonValueSchema);
export const responseCodec9 = z
	.object({ id: z.string() })
	.catchall(gatewayJsonValueSchema);
export const responseCodec10 = z
	.object({ id: z.string() })
	.catchall(gatewayJsonValueSchema);
export const responseCodec11 = z
	.object({ id: z.string() })
	.catchall(gatewayJsonValueSchema);
const fileIndexWireResponseCodec = z
	.object({
		message: z.union([z.string(), z.null()]).optional(),
		state: z.union([z.string(), z.null()]).optional(),
		warnings: z.union([z.array(z.string()), z.null()]).optional(),
	})
	.catchall(gatewayJsonValueSchema);
export const responseCodec12 = z
	.object({
		byte_size: z.number().optional(),
		id: z.string(),
		index: z.union([fileIndexWireResponseCodec, z.null()]).optional(),
		mime: z.string().optional(),
	})
	.catchall(gatewayJsonValueSchema);
const documentWriteReceiptWireResponseCodec = z
	.object({
		changed: z.boolean().optional(),
		duplicate: z.boolean().optional(),
		revision: z.number().optional(),
		updated_at: z.number().optional(),
		version_id: z.union([z.string(), z.null()]).optional(),
	})
	.catchall(gatewayJsonValueSchema);
export const responseCodec13 = z
	.object({ result: documentWriteReceiptWireResponseCodec.optional() })
	.catchall(gatewayJsonValueSchema);
export const responseCodec14 = z
	.object({ removed: z.boolean().optional() })
	.catchall(gatewayJsonValueSchema);
const documentKindResponseCodec = z.union([
	z.literal("page"),
	z.literal("database"),
	z.literal("whiteboard"),
]);
const documentVersionMetaWireResponseCodec = z
	.object({
		capture_type: z.string().optional(),
		created_at: z.number(),
		created_by: z.union([z.string(), z.null()]).optional(),
		document_id: z.string(),
		granularity: z.string().optional(),
		id: z.string(),
		kind: documentKindResponseCodec,
		label: z.union([z.string(), z.null()]).optional(),
		revision: z.number().optional(),
		title: z.string(),
		updated_at: z.number().optional(),
	})
	.catchall(gatewayJsonValueSchema);
export const responseCodec15 = z.array(documentVersionMetaWireResponseCodec);
export const documentVersionWireResponseCodec = z.intersection(
	documentVersionMetaWireResponseCodec,
	z.object({ source: z.string() }).catchall(gatewayJsonValueSchema)
);
export const responseCodec16 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
export const responseCodec17 = z
	.object({ result: documentWriteReceiptWireResponseCodec.optional() })
	.catchall(gatewayJsonValueSchema);
export const reindexStatusWireResponseCodec = z
	.object({
		current_dims: z.number(),
		current_model: z.string(),
		pending_chunks: z.number(),
		running: z.boolean(),
		total_chunks: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
export const responseCodec18 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
export const embeddingModelWireResponseCodec = z
	.object({
		base_url: z.string().optional(),
		dims: z.number(),
		model_id: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
export const responseCodec19 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
const matchWireResponseCodec = z
	.object({
		chunk_id: z.string(),
		content: z.string(),
		distance: z.number(),
		document_id: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
export const responseCodec20 = z
	.object({ matches: z.array(matchWireResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);
const docLinkWireResponseCodec = z
	.object({
		dst_doc_id: z.union([z.string(), z.null()]),
		dst_title: z.string(),
		kind: z.string(),
		snippet: z.string().optional(),
		src_doc_id: z.string(),
		src_title: z.string().optional(),
	})
	.catchall(gatewayJsonValueSchema);
export const responseCodec21 = z
	.object({ backlinks: z.array(docLinkWireResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);
export const responseCodec22 = z
	.object({ links: z.array(docLinkWireResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);
const docGraphEdgeResponseCodec = z
	.object({ dst: z.string(), kind: z.string(), src: z.string() })
	.catchall(gatewayJsonValueSchema);
export const docGraphWireResponseCodec = z
	.object({
		edges: z.array(docGraphEdgeResponseCodec),
		nodes: z.array(
			z
				.object({
					id: z.string(),
					kind: z.string(),
					pending: z.boolean(),
					space_id: z.string(),
					title: z.string(),
				})
				.catchall(gatewayJsonValueSchema)
		),
	})
	.catchall(gatewayJsonValueSchema);

const glyphValueResponseCodec = gatewayJsonValueSchema.transform(asGlyphValue);
const spaceWireResponseCodec = z
	.object({
		created_at: z.number(),
		description: z.string().nullable().optional(),
		document_count: z.number(),
		icon: glyphValueResponseCodec.optional(),
		id: z.string(),
		name: z.string(),
		retrieval_mode: z.string().optional(),
		system: z.boolean().optional(),
		team_id: z.string().nullable().optional(),
		updated_at: z.number(),
		visibility: z.string().optional(),
	})
	.catchall(gatewayJsonValueSchema);
export const listSpacesResponseCodec = z
	.object({ spaces: z.array(spaceWireResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);
const documentWireResponseCodec = z
	.object({
		byte_size: z.number().nullable().optional(),
		chunk_count: z.number(),
		created_at: z.number(),
		icon: glyphValueResponseCodec.optional(),
		id: z.string(),
		index: fileIndexWireResponseCodec.nullable().optional(),
		kind: z.string().optional(),
		mime: z.string().nullable().optional(),
		space_id: z.string(),
		title: z.string(),
		updated_at: z.number().optional(),
	})
	.catchall(gatewayJsonValueSchema);
export const listDocumentsResponseCodec = z
	.object({ documents: z.array(documentWireResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);

export const documentContentWireResponseCodec = z
	.object({
		chunk_count: z.number(),
		created_at: z.number(),
		icon: glyphValueResponseCodec.optional(),
		id: z.string(),
		kind: z.string().optional(),
		source: z.string(),
		space_id: z.string(),
		title: z.string(),
		updated_at: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
