// The two owned Cores the settings sync proof selects between. The desktop's
// node registry (nodes.json) answers them through the native `list_nodes`
// command, so an account switch, which re-reads that registry, keeps them.
export const proofNode = {
	name: "Owned Core",
	url: "http://127.0.0.1:5607/core",
	token: "owned-core",
	userJwt: null,
};
export const otherProofNode = {
	name: "Other Core",
	url: "http://127.0.0.1:5607/other-core",
	token: "owned-core-B",
	userJwt: null,
};
