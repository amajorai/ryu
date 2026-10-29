import { I18nProvider } from "@ryu/i18n/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import App from "../../src/App.tsx";
import { queryClient } from "../../src/lib/query-client.ts";
import "../../src/index.css";
queryClient.setDefaultOptions({
	queries: { retry: false, refetchOnWindowFocus: false },
});
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing startup proof root");
}
createRoot(root).render(
	<I18nProvider>
		<QueryClientProvider client={queryClient}>
			<App hostSurface="desktop" />
		</QueryClientProvider>
	</I18nProvider>
);
