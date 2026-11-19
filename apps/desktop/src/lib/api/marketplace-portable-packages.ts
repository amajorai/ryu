// apps/desktop/src/lib/api/marketplace-portable-packages.ts
//
// Core-node portable package install, enable and uninstall calls.
// Split out of marketplace.ts (which re-exports it); see that file's header
// for the control-plane contract.

import type { MarketplaceKind } from "@ryu/marketplace/types";
import {
	type ApiTarget,
	buyerTokenHeader,
	request,
} from "@/src/lib/api/client.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
import {
	installedPortablePackagesSchema,
	parseMarketplaceResponse,
	portablePackageEnvelopeSchema,
} from "./marketplace-response-contracts.ts";

export interface PortablePackageState {
	enabled: boolean;
	id: string;
	installed_at_unix_ms: number;
	kind: string;
	package_digest: string;
	version: string;
}

export async function fetchInstalledPortablePackages(
	target: ApiTarget
): Promise<PortablePackageState[]> {
	const result = await request(
		target,
		"/api/marketplace/packages/installed",
		{},
		gatewayJsonValueSchema
	);
	return (
		parseMarketplaceResponse(installedPortablePackagesSchema, result)
			.packages ?? []
	);
}

/** Record one Core-verified Marketplace install action for anonymous community
 * usage. Core owns the increment; this client never sends a caller-supplied
 * counter and failures are intentionally ignored by bundle orchestration. */
export async function recordMarketplaceUsage(
	target: ApiTarget,
	input: { event: "download"; id: string; kind: MarketplaceKind }
): Promise<void> {
	await request(
		target,
		"/api/marketplace/usage",
		{
			method: "POST",
			body: input,
		},
		gatewayJsonValueSchema
	);
}

/**
 * Install or update a GitHub-backed `.ryupack` through the selected node.
 *
 * The control-plane session is carried separately from the node token: Core
 * uses it only when it asks Ryu to resolve optional account-aware commerce and
 * proxy the private GitHub Release. Buyers never need GitHub credentials or a
 * GitHub App installation of their own.
 */
export async function installPortablePackage(
	target: ApiTarget,
	input: { kind: string; id: string },
	options: {
		installSession?: string;
		update?: boolean;
		version?: string;
	} = {}
): Promise<PortablePackageState> {
	const path = options.update
		? "/api/marketplace/packages/update"
		: "/api/marketplace/packages/install";
	const body: PortablePackageInstallRequest = { ...input };
	if (options.version) {
		body.version = options.version;
	}
	if (options.installSession) {
		body.install_session = options.installSession;
	}
	const result = await request(
		target,
		path,
		{
			method: "POST",
			headers: buyerTokenHeader(target),
			body,
		},
		gatewayJsonValueSchema
	);
	return parseMarketplaceResponse(portablePackageEnvelopeSchema, result)
		.package;
}

export async function setPortablePackageEnabled(
	target: ApiTarget,
	input: { kind: string; id: string },
	enabled: boolean
): Promise<PortablePackageState> {
	const result = await request(
		target,
		`/api/marketplace/packages/${encodeURIComponent(input.kind)}/${encodeURIComponent(input.id)}/${enabled ? "enable" : "disable"}`,
		// Enable re-checks a paid package's license with the signed-in account.
		{ method: "POST", headers: enabled ? buyerTokenHeader(target) : {} },
		gatewayJsonValueSchema
	);
	return parseMarketplaceResponse(portablePackageEnvelopeSchema, result)
		.package;
}

export async function uninstallPortablePackage(
	target: ApiTarget,
	input: { kind: string; id: string }
): Promise<void> {
	await request(
		target,
		"/api/marketplace/packages/" +
			encodeURIComponent(input.kind) +
			"/" +
			encodeURIComponent(input.id) +
			"/uninstall",
		{
			method: "POST",
		},
		gatewayJsonValueSchema
	);
}

interface PortablePackageInstallRequest {
	id: string;
	install_session?: string;
	kind: string;
	version?: string;
}
