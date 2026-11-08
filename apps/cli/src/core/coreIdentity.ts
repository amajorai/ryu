// The Core identity challenge lives in core-client so ryu-mcp applies the same
// check; this path stays for the CLI's existing imports and renders the
// identity failure through the CLI catalog.
import {
	CORE_IDENTITY_CONFLICT_HINT,
	setCoreIdentityErrorText,
} from "@ryuhq/core-client/core-identity";
import { tf, tr } from "../i18n/translate.ts";

export * from "@ryuhq/core-client/core-identity";

/**
 * The conflict hint spelled out as a literal so the catalog extractor keeps
 * its key; it must match `CORE_IDENTITY_CONFLICT_HINT` exactly.
 */
export const conflictHintText = (): string =>
	tr(
		"Another program may be using this port; stop it, or update Ryu Core if it is an older version. The check also fails when the saved token is not this Core's own node token (for example a paired-device or delegated token), and when the address is a port forward that does not reach Core on the same loopback address and port number (forward to the same address and port, such as 127.0.0.1:7980, instead)"
	);

/** Translates a hint, routing the known conflict hint through its literal key. */
export function localizedCoreIdentityHint(hint: string): string {
	return hint === CORE_IDENTITY_CONFLICT_HINT ? conflictHintText() : tr(hint);
}

setCoreIdentityErrorText((url, hint) =>
	tf(
		"The process answering at {url} could not prove it is your Ryu Core, so the CLI did not send it your token. {hint}.",
		{ hint: localizedCoreIdentityHint(hint), url }
	)
);
