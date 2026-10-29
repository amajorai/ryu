import { z } from "zod";

export const retrievalModeChangeWireSchema = z
	.object({
		changed: z.boolean().optional(),
		chunks_scanned: z.number().optional(),
		graph_edges: z.number().optional(),
		graph_nodes: z.number().optional(),
		graph_rebuilt: z.boolean().optional(),
		job_id: z.string().optional(),
		mode: z.string().optional(),
		note: z.string().optional(),
		previous: z.string().optional(),
		previous_retrieval_mode: z.string().optional(),
		retrieval_mode: z.string().optional(),
		space_id: z.string().optional(),
		cancel: z.string().optional(),
		requested_mode: z.string().optional(),
		status: z.string().optional(),
	})
	.catchall(z.json());
export const retrievalModeJobWireSchema = z
	.object({
		cancel: z.string().optional(),
		job_id: z.string(),
		requested_mode: z.string().optional(),
		space_id: z.string(),
		status: z.string().optional(),
	})
	.catchall(z.json());
export const retrievalModeStatusWireSchema = z
	.object({
		change: retrievalModeChangeWireSchema.nullish(),
		error: z.string().nullish(),
		job_id: z.string(),
		processed_chunks: z.number().optional(),
		requested_mode: z.string().optional(),
		space_id: z.string(),
		state: z.string(),
		total_chunks: z.number().optional(),
	})
	.catchall(z.json());
export const retrievalModeCancelWireSchema = z
	.object({
		cancelled: z.boolean(),
		finalizing: z.boolean().optional(),
	})
	.catchall(z.json());
export const retrievalModeStateSchema = z.enum([
	"running",
	"cancelling",
	"completed",
	"cancelled",
	"failed",
]);
export const spaceFileUploadWireSchema = z
	.object({
		byte_size: z.number().optional(),
		id: z.string(),
		index: z
			.object({
				message: z.string().nullable().optional(),
				state: z.string().nullable().optional(),
				warnings: z.array(z.string()).nullable().optional(),
			})
			.catchall(z.json())
			.nullable()
			.optional(),
		mime: z.string().optional(),
	})
	.catchall(z.json());
export const spaceUploadErrorSchema = z.object({
	error: z.json().optional(),
	message: z.json().optional(),
});
export const databaseQueryEnvelopeSchema = z.object({
	columns: z.array(z.string()),
	rows: z.array(z.array(z.json())),
	schema: z.array(z.json()),
	truncated: z.boolean(),
});
export const databaseQueryColumnSchema = z.object({
	id: z.string(),
	label: z.string(),
	name: z.string(),
});
