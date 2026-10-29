import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const name = "Isolated provider runtime verification";
useNodeStore.setState({
	nodes: [
		{
			name,
			url: window.location.origin,
			token: null,
			userJwt: null,
			managed: false,
		},
	],
	defaultNode: name,
});
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={new QueryClient()}>
			<GatewayDialog
				defaultSection="keys"
				onOpenChange={() => {}}
				open={true}
			/>
		</QueryClientProvider>
	);
}
