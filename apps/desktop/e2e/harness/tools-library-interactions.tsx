import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import ToolsLibrary from "@/src/components/tools/ToolsLibrary.tsx";
import { queryClient } from "@/src/lib/query-client.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import "../../src/index.css";

useNodeStore.setState({
	nodes: [
		{
			name: "Tools Library fixture",
			url: "http://127.0.0.1:5224",
			token: null,
			userJwt: null,
		},
	],
	defaultNode: "Tools Library fixture",
	autoSelect: false,
});

function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<main className="h-screen p-6">
				<h1 className="mb-4 font-semibold text-lg">Tools Library fixture</h1>
				<div className="h-[calc(100vh-5rem)] min-h-0">
					<ToolsLibrary />
				</div>
			</main>
		</QueryClientProvider>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
