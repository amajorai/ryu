/** Launch the proof URL with #proof-token=<RYU_PROOF_CLIENT_TOKEN>. */
export function consumeProofClientToken(): string {
	const token = new URLSearchParams(window.location.hash.slice(1)).get(
		"proof-token"
	);
	window.history.replaceState(
		null,
		"",
		`${window.location.pathname}${window.location.search}`
	);
	if (!(token && /^[a-zA-Z0-9_-]{43,128}$/.test(token))) {
		throw new Error(
			"Open this live proof with its launcher-supplied proof-token fragment."
		);
	}
	return token;
}
