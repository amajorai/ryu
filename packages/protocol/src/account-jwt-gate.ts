// @ryuhq/protocol - the one rule for sending the signed-in account's JWT to a
// Core node, shared by desktop, mobile and the browser extension.
//
// The account JWT (Better Auth, minted at `/api/auth/token`) is not bound to a
// node: its audience is the control plane, the same for every node, and an
// org-bound node admits it as a bearer for about 15 minutes. A server that
// receives it can therefore replay it against the member's other nodes. So a
// client sends it only where all of this holds:
//
// - the node holds an admission credential (a node token, or a node-bound
//   managed delegation), so the request is one the node already admits;
// - the transport is confidential: `https:`, or plain `http:` to this device
//   only. Over cleartext to another host anyone on the path could read it;
// - the node was not saved from a `ryu://nodes/connect` link. Such a link
//   supplies the address and the token together, so the two checks above say
//   nothing about whose server it is. A link-added node gets its node token
//   only.
//
// Residual, not closed here: a node the user added by hand over `https:` still
// receives the account JWT, whoever runs it. Closing that needs a node-bound
// credential checked by Core.

import { parseNodeUrl } from "./node-url.ts";

export interface AccountJwtTarget {
	/**
	 * True when the node was saved from a `ryu://nodes/connect` link and the
	 * user has not added it by hand since. Required, so each surface states how
	 * it knows.
	 */
	addedByLink: boolean;
	/** A node-bound managed delegation; counts as an admission credential. */
	delegation?: string | null;
	/** The node's own admission token. */
	token?: string | null;
	url: string;
}

/** TLS to any host, or a Core on this device. Cleartext to another host is not. */
export function hasConfidentialTransport(url: string): boolean {
	const parts = parseNodeUrl(url);
	return parts !== null && (parts.scheme === "https" || parts.loopback);
}

/** Whether the node holds a credential of its own that admits the request. */
export function hasAdmissionCredential(
	target: Pick<AccountJwtTarget, "delegation" | "token">
): boolean {
	return Boolean(target.token?.trim() || target.delegation?.trim());
}

/** Whether the signed-in, account-wide JWT may be attached for `target`. */
export function mayAttachAccountJwt(target: AccountJwtTarget): boolean {
	return (
		target.addedByLink === false &&
		hasAdmissionCredential(target) &&
		hasConfidentialTransport(target.url)
	);
}
