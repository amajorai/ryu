import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { queryClient } from "../../src/lib/query-client.ts";
import HostedStandaloneAppEntry from "../../src/pages/HostedStandaloneAppEntry.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "@fontsource-variable/geist";
import "../../src/index.css";
useNodeStore.setState({
	defaultNode: "local",
	nodes: [
		{
			name: "local",
			url: "http://127.0.0.1:5493",
			token: "sidebar-test-token",
		},
	],
});
queryClient.clear();
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing root");
}
createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
			<HostedStandaloneAppEntry appId="@ryu/records" />
		</ThemeProvider>
	</QueryClientProvider>
);
