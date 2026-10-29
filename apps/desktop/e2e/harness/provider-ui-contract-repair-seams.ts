export {
	useActiveNode,
	useActiveNodeGetter,
	useCanManagePermission,
	useGatewayConfigurable,
} from "./gateway-dialog-accounts-seams.ts";

export function useGatewayStatus() {
	return {
		status: {
			reachable: true,
			running: true,
			health: {
				status: "ok",
				providers: [
					"huggingface",
					"mistral",
					"nvidia",
					"together",
					"fireworks",
				],
			},
			metrics: null,
		},
		loading: false,
		error: null,
		refresh: async () => {},
	};
}
