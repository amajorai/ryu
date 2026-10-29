// packages/marketplace/src/catalog/remix.ts
//
// Remixing a listing: making an editable copy of it, changing it, and
// publishing the result as your own listing with a credit to the original.
//
// Every listing is remixable unless its manifest says `"allowRemix": false`.
// The credit is the remix's own manifest `remixedFrom` ({ kind, id, version }),
// which the Marketplace shows on both listings and checks at publish time: a
// publish that credits an opted-out listing from another publisher is refused.
//
// How the editable copy is made depends on the listing:
//  - a listing with a public GitHub repository is forked on GitHub;
//  - an agent or workflow template is added in Ryu, which already installs it
//    as a new, unlocked copy the user owns and can edit;
//  - anything else has no copyable source here, so it is not offered.

import { safeHttpUrl } from "./safe-url.ts";
import type { CatalogEntry } from "./types.ts";

/** The listing a remix credits, as written in the remix's `remixedFrom`. */
export interface RemixSource {
	id: string;
	kind: string;
	version?: string | null;
}

/** The parts of a listing the remix decision reads. */
export interface RemixableListing {
	/** Manifest `allowRemix`; absent or null means allowed. */
	allowRemix?: boolean | null;
	/** Bound GitHub source repository as `owner/name`, when published from GitHub. */
	githubRepository?: string | null;
	id: string;
	kind: string;
	/** Manifest `repository` URL, when declared. */
	repositoryUrl?: string | null;
	version?: string | null;
}

export type RemixPlan =
	| { kind: "blocked" }
	| { kind: "unavailable" }
	| { forkUrl: string; kind: "fork"; repositoryUrl: string }
	| { kind: "copy" };

/** Kinds whose install already creates an editable copy the user owns. */
const COPY_ON_INSTALL_KINDS = new Set(["agent", "workflow", "stack_template"]);

const GITHUB_SLUG = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** Whether a listing allows remixes. Absent means allowed. */
export function remixAllowed(listing: Pick<RemixableListing, "allowRemix">) {
	return listing.allowRemix !== false;
}

/**
 * The canonical `https://github.com/owner/name` for a GitHub repository URL or
 * `owner/name` slug, or null when the input is not a GitHub repository.
 */
export function githubRepositoryUrl(
	value: string | null | undefined
): string | null {
	const trimmed = value?.trim();
	if (!trimmed) {
		return null;
	}
	if (GITHUB_SLUG.test(trimmed)) {
		return `https://github.com/${trimmed.replace(/\.git$/, "")}`;
	}
	const url = safeHttpUrl(trimmed);
	if (!url) {
		return null;
	}
	const parsed = new URL(url);
	if (
		parsed.hostname !== "github.com" &&
		parsed.hostname !== "www.github.com"
	) {
		return null;
	}
	const [owner, name] = parsed.pathname.split("/").filter(Boolean);
	const slug = owner && name ? `${owner}/${name.replace(/\.git$/, "")}` : "";
	return GITHUB_SLUG.test(slug) ? `https://github.com/${slug}` : null;
}

/** Decide how this listing can be remixed, if at all. */
export function remixPlan(listing: RemixableListing): RemixPlan {
	if (!remixAllowed(listing)) {
		return { kind: "blocked" };
	}
	const repositoryUrl =
		githubRepositoryUrl(listing.githubRepository) ??
		githubRepositoryUrl(listing.repositoryUrl);
	if (repositoryUrl) {
		return { forkUrl: `${repositoryUrl}/fork`, kind: "fork", repositoryUrl };
	}
	if (COPY_ON_INSTALL_KINDS.has(listing.kind)) {
		return { kind: "copy" };
	}
	return { kind: "unavailable" };
}

/** The `remixedFrom` credit a remix of this listing declares. */
export function remixSourceOf(listing: RemixableListing): RemixSource {
	const version = listing.version?.trim();
	return version
		? { id: listing.id, kind: listing.kind, version }
		: { id: listing.id, kind: listing.kind };
}

/** The `ryu.package.json` lines that credit this listing, ready to paste. */
export function remixCreditSnippet(listing: RemixableListing): string {
	const credit = JSON.stringify(
		{ remixedFrom: remixSourceOf(listing) },
		null,
		2
	);
	// Drop the wrapping braces so the lines paste into an existing object.
	return credit.split("\n").slice(1, -1).join("\n").replace(/^ {2}/gm, "");
}

/** Read the remix inputs off a Core catalog card (snake_case keys). */
export function remixableFromEntry(
	entry: Pick<
		CatalogEntry,
		| "allow_remix"
		| "github_source"
		| "id"
		| "repo_url"
		| "repository_url"
		| "type"
		| "version"
	>
): RemixableListing {
	const repository = entry.github_source?.repository;
	return {
		allowRemix: entry.allow_remix ?? null,
		githubRepository: typeof repository === "string" ? repository : null,
		id: entry.id,
		kind: entry.type ?? "plugin",
		repositoryUrl: entry.repository_url ?? entry.repo_url ?? null,
		version: entry.version ?? null,
	};
}

/** A remix credit safe to render: both strings present and bounded. */
export function displayRemixSource(
	source:
		| { id?: string | null; kind?: string | null; version?: string | null }
		| null
		| undefined
): RemixSource | null {
	const id = typeof source?.id === "string" ? source.id.trim() : "";
	const kind = typeof source?.kind === "string" ? source.kind.trim() : "";
	if (!(id && kind) || id.length > 200 || kind.length > 40) {
		return null;
	}
	const version =
		typeof source?.version === "string" ? source.version.trim() : "";
	return version ? { id, kind, version } : { id, kind };
}
