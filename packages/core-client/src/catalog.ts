import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";
import { sidecarStatusResponseSchema } from "./system.ts";

function nativeResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const nativeCatalogItemSchema = nativeResponse(
	z.object({
		name: z.string(),
		display_name: z.string(),
		description: z.string(),
		category: z.string(),
		deprecated: z.boolean(),
		recommended: z.boolean(),
		latest_version: z.string().nullable(),
		installed_version: z.string().nullable(),
		install_state: z.string(),
		platforms: z.array(z.string()).optional(),
		supported: z.boolean().optional(),
		unsupported_reason: z.string().nullable().optional(),
		update_available: z.boolean().optional(),
	})
);
export const nativeCatalogResponseSchema = nativeResponse(
	z.object({ sidecars: z.array(nativeCatalogItemSchema).optional() })
);

export interface CatalogItem {
	category: string;
	deprecated: boolean;
	description: string;
	display_name: string;
	install_state: string;
	installed_version: string | null;
	latest_version: string | null;
	name: string;
	/** Additive current native metadata; omitted by older nodes. */
	platforms?: string[];
	recommended: boolean;
	supported?: boolean;
	/** Core's plain-language reason this node can't run the entry (e.g. "Requires
	 *  Apple Silicon"); null/omitted when supported or on an older node. */
	unsupported_reason?: string | null;
	update_available?: boolean;
}

export interface SidecarStatus {
	name: string;
	running: boolean;
}

export interface ServiceEntry extends CatalogItem {
	running: boolean;
}

export async function fetchSidecarStatus(
	target: ApiTarget
): Promise<SidecarStatus[]> {
	const json = await request(
		target,
		"/api/sidecar/status",
		{},
		sidecarStatusResponseSchema
	);
	return json.sidecars ?? [];
}

export async function fetchCatalog(target: ApiTarget): Promise<CatalogItem[]> {
	const json = await request(
		target,
		"/api/catalog",
		{},
		nativeCatalogResponseSchema
	);
	return json.sidecars ?? [];
}

export async function fetchServices(
	target: ApiTarget
): Promise<ServiceEntry[]> {
	const [statuses, catalog] = await Promise.all([
		fetchSidecarStatus(target),
		fetchCatalog(target),
	]);
	const statusByName = new Map(
		statuses.map((status) => [status.name, status.running])
	);
	return catalog.map((item) => ({
		...item,
		running: statusByName.get(item.name) ?? false,
	}));
}
