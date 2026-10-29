const activeNode = {
	token: "crm-table-proof-node-token",
	url: window.location.origin,
	userJwt: null,
};

export function useActiveNode() {
	return activeNode;
}
