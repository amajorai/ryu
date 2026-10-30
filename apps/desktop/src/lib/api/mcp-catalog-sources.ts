import type {
	McpCatalogSource,
	McpCatalogSources,
} from "@ryuhq/core-client/mcp.ts";
import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

const sourceWireResponseCodec: z.ZodType<SourceWire> = z
	.object({
		base_url: z.union([z.string(), z.null()]).optional(),
		builtin: z.boolean().optional(),
		display_name: z.string(),
		id: z.string(),
	})
	.passthrough();

// ── MCP catalog sources (#464) ───────────────────────────────────────────────
//
// The MCP catalog can be backed by more than one source (the official MCP
// registry by default, with Smithery / a Ryu-hosted registry behind the same
// seam). The active source lives in Core; the dropdown lists them and selects
// one, after which the catalog re-keys against the newly-active endpoint.

interface SourceWire {
	base_url?: string | null;
	builtin?: boolean;
	display_name: string;
	id: string;
}

function toSource(w: SourceWire): McpCatalogSource {
	return {
		id: w.id,
		displayName: w.display_name,
		builtin: w.builtin ?? false,
		baseUrl: w.base_url ?? null,
	};
}

/** List the MCP catalog sources and which one is active. */
export async function fetchMcpSources(
	target: ApiTarget
): Promise<McpCatalogSources> {
	const json = await request<{
		active?: string;
		sources?: SourceWire[];
	}>(
		target,
		"/api/catalog/sources?kind=mcp",
		{},
		z
			.object({
				active: z.string().optional(),
				sources: z.array(sourceWireResponseCodec).optional(),
			})
			.passthrough()
	);
	return {
		active: json.active ?? "",
		sources: (json.sources ?? []).map(toSource),
	};
}

/** Select the active MCP catalog source by id. */
export async function selectMcpSource(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request<unknown>(
		target,
		"/api/catalog/sources/select",
		{
			method: "POST",
			body: { kind: "mcp", id },
		},
		gatewayJsonValueSchema
	);
}
