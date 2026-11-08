// packages/core-client/src/vault/references.ts
//
// Reference grammar: part of the Secret Vault client. `../vault.ts` re-exports
// these names and documents the wire conventions.

import {
	ENV_SLUG,
	FOLDER_SEGMENT,
	MAX_FOLDER_DEPTH,
	SECRET_NAME,
} from "./codecs-human-engines.ts";

export interface VaultReference {
	environment?: string;
	name: string;
	path?: string;
}

/** Parse `NAME`, `/folder/NAME`, `ENV:NAME`, or `ENV:/folder/NAME` (the
 *  `secret:` prefix is optional). Returns null when it does not parse. */
export function parseVaultReference(input: string): VaultReference | null {
	let rest = input.trim();
	if (rest.startsWith("secret:")) {
		rest = rest.slice("secret:".length);
	}
	let environment: string | undefined;
	const colon = rest.indexOf(":");
	if (colon !== -1) {
		environment = rest.slice(0, colon);
		rest = rest.slice(colon + 1);
		if (!ENV_SLUG.test(environment)) {
			return null;
		}
	}
	let path: string | undefined;
	if (rest.startsWith("/")) {
		const segments = rest.split("/").slice(1);
		const name = segments.pop() ?? "";
		if (
			segments.length > MAX_FOLDER_DEPTH ||
			!segments.every((segment) => FOLDER_SEGMENT.test(segment))
		) {
			return null;
		}
		path = segments.length === 0 ? "/" : `/${segments.join("/")}`;
		rest = name;
	}
	if (!SECRET_NAME.test(rest)) {
		return null;
	}
	const reference: VaultReference = { name: rest };
	if (environment !== undefined) {
		reference.environment = environment;
	}
	if (path !== undefined) {
		reference.path = path;
	}
	return reference;
}
