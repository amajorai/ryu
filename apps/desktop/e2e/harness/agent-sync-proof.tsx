import "@/src/index.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GatewayDialog } from "@/src/components/gateway/GatewayDialog.tsx";
import { queryClient } from "@/src/lib/query-client.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

const gatewayFixtureNode = {
	name: "Agent sync fixture node",
	token: "fixture-node-token",
	url: "http://127.0.0.1:7980",
	userJwt: "fixture-user-jwt",
};

useNodeStore.setState({
	defaultNode: gatewayFixtureNode.name,
	localNodes: [gatewayFixtureNode],
	nodes: [gatewayFixtureNode],
});

function AgentSyncGatewayProof() {
	const [open, setOpen] = useState(true);
	return (
		<QueryClientProvider client={queryClient}>
			<GatewayDialog
				defaultSection="import"
				onOpenChange={setOpen}
				open={open}
			/>
		</QueryClientProvider>
	);
}

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Agent sync Gateway proof root is missing.");
}

createRoot(rootElement).render(<AgentSyncGatewayProof />);
