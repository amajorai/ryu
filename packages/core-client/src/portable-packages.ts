/** Core-node client for generic portable-package lifecycle operations.
 *
 * Language packs use this same install/enable path as every other portable
 * package. The module intentionally keeps the manifest payload opaque so the
 * native and extension shells cannot accidentally grow a second package format.
 */

import { z } from "zod";
import {
	type AppResponseValue,
	appResponseValueSchema,
} from "./app-request-json.ts";
import { type ApiTarget, buyerTokenHeader, request } from "./client.ts";

export interface PortablePackageState {
	enabled: boolean;
	id: string;
	kind: string;
	version: string;
	/** Future installed-package fields arrive through native JSON HTTP. */
	[key: string]: AppResponseValue;
}

// Complete native InstalledPackage, including activation IDs and digest/time.
// runtime_ids was additive and its Rust owner defaults older persisted records.
function portableResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const installedPortableFields = z.object({
	id: z.string(),
	kind: z.string(),
	version: z.string(),
	package_digest: z.string(),
	enabled: z.boolean(),
	runtime_ids: z.array(z.string()).optional(),
	installed_at_unix_ms: z.number(),
});
export const installedPortableResponseSchema = portableResponse(
	installedPortableFields
);
const installedPortableListSchema = portableResponse(
	z.object({ packages: z.array(installedPortableResponseSchema).nullish() })
);
const installedPortableEnvelopeSchema = portableResponse(
	z.object({ success: z.boolean(), package: installedPortableResponseSchema })
);

export async function fetchInstalledPortablePackages(
	target: ApiTarget
): Promise<PortablePackageState[]> {
	const result = await request(
		target,
		"/api/marketplace/packages/installed",
		{},
		installedPortableListSchema
	);
	return result.packages ?? [];
}

function portableInstallBody(
	input: Parameters<typeof installPortablePackage>[1],
	options: NonNullable<Parameters<typeof installPortablePackage>[2]>
) {
	const body: typeof input & { version?: string } = { ...input };
	if (options.version) {
		body.version = options.version;
	}
	return body;
}

export async function installPortablePackage(
	target: ApiTarget,
	input: { id: string; kind: string },
	options: { update?: boolean; version?: string } = {}
): Promise<PortablePackageState> {
	const result = await request(
		target,
		options.update
			? "/api/marketplace/packages/update"
			: "/api/marketplace/packages/install",
		{
			body: portableInstallBody(input, options),
			headers: buyerTokenHeader(target),
			method: "POST",
		},
		installedPortableEnvelopeSchema
	);
	return result.package;
}

export async function setPortablePackageEnabled(
	target: ApiTarget,
	input: { id: string; kind: string },
	enabled: boolean
): Promise<PortablePackageState> {
	const path =
		"/api/marketplace/packages/" +
		encodeURIComponent(input.kind) +
		"/" +
		encodeURIComponent(input.id) +
		"/" +
		(enabled ? "enable" : "disable");
	const result = await request(
		target,
		path,
		{ method: "POST" },
		installedPortableEnvelopeSchema
	);
	return result.package;
}
