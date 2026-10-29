import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import PluginViewPage from "../../src/pages/PluginViewPage.tsx";
import "../../src/index.css";
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={new QueryClient()}>
		<TooltipProvider>
			<PluginViewPage
				pluginId={
					location.search.includes("custom")
						? "com.example.author"
						: "com.ryu.blueprint"
				}
				viewId={
					location.search.includes("custom")
						? "author-form"
						: "surface:blueprint"
				}
			/>
			<Toaster />
		</TooltipProvider>
	</QueryClientProvider>
);
