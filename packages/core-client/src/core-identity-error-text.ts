// The CoreIdentityError wording and the hook a host (the CLI) uses to render it
// in its own locale; split from core-identity.ts so that module stays small.

/**
 * Why a listener can fail the challenge, and what to do. The proof is keyed by
 * this Core's own node token and the local address and port its connection was
 * accepted on, so a paired-device or delegated token, or a port forward that
 * lands on another address or port, fails the same way a relaying squatter
 * does: the CLI cannot tell them apart and fails closed.
 */
export const CORE_IDENTITY_CONFLICT_HINT =
	"Another program may be using this port; stop it, or update Ryu Core if it is an older version. The check also fails when the saved token is not this Core's own node token (for example a paired-device or delegated token), and when the address is a port forward that does not reach Core on the same loopback address and port number (forward to the same address and port, such as 127.0.0.1:7980, instead)";

/** Renders the {@link CoreIdentityError} message for a URL and the conflict hint. */
export type CoreIdentityErrorText = (url: string, hint: string) => string;

const englishCoreIdentityErrorText: CoreIdentityErrorText = (url, hint) =>
	`The process answering at ${url} could not prove it is your Ryu Core, so the CLI did not send it your token. ${hint}.`;

let coreIdentityErrorText: CoreIdentityErrorText = englishCoreIdentityErrorText;

/**
 * Let a host (the CLI) render the identity failure in its own locale. Passing
 * `null` restores the English text.
 */
export function setCoreIdentityErrorText(
	text: CoreIdentityErrorText | null
): void {
	coreIdentityErrorText = text ?? englishCoreIdentityErrorText;
}

/** The rendered CoreIdentityError message for a URL. */
export function coreIdentityErrorMessage(url: string): string {
	return coreIdentityErrorText(url, CORE_IDENTITY_CONFLICT_HINT);
}
