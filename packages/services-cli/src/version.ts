// packages/services-cli/src/version.ts
//
// The CLI's own version, printed by `ryu-services --version` and sent as the
// MCP serverInfo.version. `exports-lockstep.test.ts` keeps it equal to
// package.json. While `@ryuhq/services` is unpublished, `--version` and
// `doctor` also print `npmStatusNote(...)`: a workspace build says so, and a
// host that bundles this CLI (`ryu-cli services`) names itself instead
// (`CliIo.bundledWith`). `standalone-sdk-docs.test.ts` keeps the wording equal
// to the docs' CLI page.

import { NPM_PUBLISHED_VERSION } from "@ryuhq/services";

/** This package's version (package.json `version`). */
export const CLI_VERSION = "0.1.0";

/**
 * The docs' install callout, which every page with an npm install command
 * carries while `NPM_PUBLISHED_VERSION` is null. Docs only: its
 * `@ryuhq/client` freshness clause is not printed by the CLI, because nothing
 * in a built binary would notice when `@ryuhq/client` is published.
 */
export const NPM_INSTALL_CALLOUT =
	"@ryuhq/services is not yet published to npm; it requires @ryuhq/client 0.4 or later, which is also not yet on npm (latest is 0.3.0).";

/**
 * The part of {@link NPM_INSTALL_CALLOUT} the CLI prints: only claims that
 * flip with `NPM_PUBLISHED_VERSION`, plus the client requirement.
 */
export const NPM_STATUS_CLAUSE =
	"@ryuhq/services is not yet published to npm; it requires @ryuhq/client 0.4 or later.";

/** Where the running CLI came from, for {@link npmStatusNote}. */
export interface NpmStatusOrigin {
	/**
	 * The host that bundles this CLI, as users name it (`ryu-cli 0.4.0`);
	 * unset for a workspace build (`bun packages/services-cli/src/bin.ts`).
	 */
	readonly bundledWith?: string;
	/** `NPM_PUBLISHED_VERSION`: the npm version, or null while unpublished. */
	readonly publishedVersion: string | null;
}

/**
 * What `--version` and `doctor` say about npm: null once `@ryuhq/services` is
 * published, otherwise where this binary came from (a workspace build, or the
 * host that bundles it) followed by {@link NPM_STATUS_CLAUSE}.
 */
export function npmStatusNote(origin: NpmStatusOrigin): string | null {
	if (origin.publishedVersion !== null) {
		return null;
	}
	const bundledWith = origin.bundledWith?.trim();
	return bundledWith
		? `This command line is bundled with ${bundledWith}, not installed from npm. ${NPM_STATUS_CLAUSE}`
		: `This @ryuhq/services-cli is a workspace build, not an npm install. ${NPM_STATUS_CLAUSE}`;
}

/** The note a workspace build prints with the real `NPM_PUBLISHED_VERSION`. */
export const NPM_STATUS_NOTE: string | null = npmStatusNote({
	publishedVersion: NPM_PUBLISHED_VERSION,
});
