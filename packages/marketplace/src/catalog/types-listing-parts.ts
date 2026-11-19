// packages/marketplace/src/catalog/types-listing-parts.ts
//
// Listing sub-records: version history, version snapshots, and the
// manifest API surface and permission summaries.
// Split out of `types.ts`, which re-exports everything here so existing import
// paths keep working.
//
// test-exempt: type-only declarations with no runtime behavior; `types.ts` re-exports them
// and the catalog section tests exercise them through that facade.

import type { CatalogSurfaceSupport } from "./types-compatibility.ts";

/** One row of the Versions tab. Sourced from published releases, falling back to
 *  git tags for a repo that tags without cutting releases (`tagOnly`). */
export interface CatalogVersion {
	/** Summed download count across the release's assets; 0 when unpublished. */
	downloads?: number | null;
	/** Manifest-declared maturity at this exact release ref. */
	installable?: boolean;
	name?: string | null;
	/** Release notes, already truncated upstream. */
	notes?: string | null;
	prerelease?: boolean;
	publishedAt?: string | null;
	/** Lowercase manifest stability value; `stable` is retained for history rows. */
	stability?: string | null;
	/** Whether the historical manifest was readable at this ref. */
	stabilityKnown?: boolean;
	/** True when this row came from a git tag with no matching release. */
	tagOnly?: boolean;
	url?: string | null;
	version: string;
}

/** A listing as it stood at ONE published version, read from its repository at
 *  that version's tag (`GET /api/plugins/catalog/version-detail`).
 *
 *  Carries ONLY signals that live in the repo and are therefore genuinely
 *  historical. Repository health — stars, open issues, archived, last-updated — is
 *  current-state, reported as of now, and is deliberately absent: showing it beside
 *  these fields would read as "the state at that version" while half of it
 *  described today. `atRef` names the tag it was read at so this can never be
 *  presented as anything but a snapshot. */
export interface VersionSnapshot {
	/** The git ref this was read at. */
	atRef?: string | null;
	description?: string | null;
	engines?: { ryu?: string | null } | null;
	license?: string | null;
	permissions?: unknown;
	readme?: string | null;
	readmeUrl?: string | null;
	/** Lowercase manifest stability value; absent means the manifest defaulted stable. */
	stability?: string | null;
	/** False when the ref could not be read as a manifest-backed snapshot. */
	stabilityKnown?: boolean;
	surfaceSupport?: CatalogSurfaceSupport[] | null;
	surfaces?: string[] | null;
	targets?: string[] | null;
	/** The version the manifest declared at that tag. */
	version?: string | null;
}

/** A named, described thing a plugin contributes (command, tool, agent, …).
 *  `name`/`description` are null when the manifest references an id it does not
 *  actually ship — surfaced, not hidden, so the health scan can flag it. */
export interface CatalogContribution {
	description?: string | null;
	id: string;
	name?: string | null;
}

/** One HTTP route a plugin's background service exposes. */
export interface CatalogRoute {
	auth?: string | null;
	methods?: string[];
	path: string;
}

/** A managed background process the plugin ships, and the HTTP surface it adds. */
export interface CatalogSidecar {
	lazy?: boolean;
	mount?: string | null;
	name: string;
	port?: number | null;
	publicMount?: string | null;
	routes?: CatalogRoute[];
}

/** A sidecar-declared model provider. This is display-only metadata for the
 * enable confirmation: the process spec and executable backend never cross the
 * catalog projection boundary. */
export interface CatalogModelProvider {
	api?: string | null;
	id: string;
	label?: string | null;
	models?: string[];
}

/** A stdio MCP server the plugin registers on enable. `envKeys` deliberately
 *  carries only the env variable NAMES — values are secrets by convention. */
export interface CatalogMcpServer {
	args?: string[];
	command?: string | null;
	description?: string | null;
	enabled?: boolean;
	envKeys?: string[];
	name: string;
}

/**
 * The **API surface** projected from a plugin's manifest — everything installing
 * it adds to the machine, structured for the detail page's reference tab.
 *
 * Projected by Core through an allowlist (`catalog_source::manifest_surface`), so
 * no field here can carry executable payload: tool backends, sidecar process
 * specs, and turn-hook code are dropped at the source.
 */
export interface CatalogApiSurface {
	agents?: CatalogContribution[];
	commands?: CatalogContribution[];
	composerControls?: {
		id: string;
		label?: string | null;
		type?: string | null;
	}[];
	mcpServers?: CatalogMcpServer[];
	modelProviders?: CatalogModelProvider[];
	policies?: CatalogContribution[];
	/** Capabilities this plugin serves to OTHER plugins via the broker. */
	provides?: {
		capability: string;
		route?: string | null;
		sidecar?: string | null;
	}[];
	runnables?: {
		description?: string | null;
		id: string;
		kind?: string | null;
		name?: string | null;
	}[];
	settingsTabs?: { icon?: string | null; id: string; title?: string | null }[];
	sidecars?: CatalogSidecar[];
	tools?: CatalogContribution[];
	/** What wakes this plugin up. */
	triggers?: {
		activationEvents?: string[];
		turnHooks?: {
			description?: string | null;
			event: string;
			id?: string | null;
		}[];
	};
	views?: {
		icon?: string | null;
		id: string;
		surface?: string | null;
		title?: string | null;
	}[];
	workflows?: CatalogContribution[];
}

/** The typed runtime permission set, summarized for display. `declared: false`
 *  means the manifest declared none — which is deny-all, the good case, and is
 *  distinct from "we don't know". */
export interface CatalogPermissions {
	childProcess?: unknown;
	declared: boolean;
	fs?: unknown;
	network?: unknown;
	tool?: unknown;
}
