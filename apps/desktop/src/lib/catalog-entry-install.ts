import { getActiveToken } from "@/lib/auth-client.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { installPortablePackage } from "@/src/lib/api/marketplace.ts";
import {
	type CatalogEntry,
	installApp,
	installPluginFromCatalog,
} from "@/src/lib/api/plugins.ts";

/**
 * Installing one catalog listing, shared by the Store and the chat's install
 * card so both refuse and route exactly the same way.
 */

/** Read the control-plane session bearer for optional Marketplace account-aware
 *  operations. Installs remain available without a plan or item license. */
export function readBuyerToken(): string | null {
	try {
		return getActiveToken();
	} catch {
		return null;
	}
}

export function portablePackageTarget(
	entry: CatalogEntry
): { id: string; kind: string } | null {
	const kind = entry.package_kind?.trim();
	if (!(kind && (entry.github_source || entry.download_url))) {
		return null;
	}
	return { id: entry.id, kind };
}

/** Why a listing can't be installed from a catalog card, or null when it can. */
export function catalogInstallRefusal(entry: CatalogEntry): string | null {
	// Community listings are unsigned and unreviewed, so Core's install-by-id
	// path is fail-closed for them by design (its descriptor carries no
	// manifest). Refuse here too, with copy that says why: installing one is an
	// explicit per-repo act, not a catalog install.
	if (entry.origin === "community") {
		return "Community listings are browse-only — open the repository to review it before installing.";
	}
	if (entry.descriptor_only) {
		return "Integration descriptors are browse-only — open the link to configure.";
	}
	return null;
}

export interface InstallCatalogEntryOptions {
	channel?: string | null;
	installed: boolean;
	/** Organization policy check: returns the refusal message, or null. */
	orgInstallBlock: (fromCatalog: boolean) => string | null;
}

/** Install (or, for a built-in, enable the install of) one catalog listing. */
export async function installCatalogEntry(
	target: ApiTarget,
	entry: CatalogEntry,
	{ channel, installed, orgInstallBlock }: InstallCatalogEntryOptions
): Promise<void> {
	const refusal = catalogInstallRefusal(entry);
	if (refusal) {
		throw new Error(refusal);
	}
	const portableTarget = portablePackageTarget(entry);
	if (portableTarget && !installed) {
		await installPortablePackage(target, portableTarget);
		return;
	}
	const orgBlock = orgInstallBlock(!installed && entry.source !== "built-in");
	if (orgBlock) {
		throw new Error(orgBlock);
	}
	if (!installed && entry.source !== "built-in") {
		await installPluginFromCatalog(target, entry.id, readBuyerToken(), channel);
		return;
	}
	// A built-in is shipped with Core, so its version IS Core's version and
	// there is no separate train to follow — a channel is meaningless here
	// and is deliberately not forwarded rather than quietly ignored downstream.
	await installApp(target, entry.id);
}
