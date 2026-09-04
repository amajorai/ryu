/** Core-node client for generic portable-package lifecycle operations.
 *
 * Language packs use this same install/enable path as every other portable
 * package. The module intentionally keeps the manifest payload opaque so the
 * native and extension shells cannot accidentally grow a second package format.
 */

import { type ApiTarget, buyerTokenHeader, request } from "./client.ts";

export interface PortablePackageState {
	enabled: boolean;
	id: string;
	kind: string;
	version: string;
	[key: string]: unknown;
}

export async function fetchInstalledPortablePackages(
	target: ApiTarget
): Promise<PortablePackageState[]> {
	const result = await request<{ packages?: PortablePackageState[] }>(
		target,
		"/api/marketplace/packages/installed"
	);
	return result.packages ?? [];
}

export async function installPortablePackage(
	target: ApiTarget,
	input: { id: string; kind: string },
	options: { update?: boolean; version?: string } = {}
): Promise<PortablePackageState> {
	const result = await request<{ package: PortablePackageState }>(
		target,
		options.update
			? "/api/marketplace/packages/update"
			: "/api/marketplace/packages/install",
		{
			body: {
				...input,
				...(options.version ? { version: options.version } : {}),
			},
			headers: buyerTokenHeader(target),
			method: "POST",
		}
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
	const result = await request<{ package: PortablePackageState }>(
		target,
		path,
		{ method: "POST" }
	);
	return result.package;
}
