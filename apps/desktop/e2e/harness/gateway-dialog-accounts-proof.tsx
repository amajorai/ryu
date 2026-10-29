import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import "../../src/index.css";
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
