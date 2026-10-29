import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { AcpRuntimeSection } from "../../src/components/gateway/AcpRuntimeSection.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import "../../src/index.css";

const target: ApiTarget = {
	token: "acp-runtime-proof-node-token",
	url: window.location.origin,
	userJwt: null,
};
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const canConfigure =
	new URLSearchParams(window.location.search).get("viewer") !== "1";

createRoot(document.getElementById("root") as HTMLElement).render(
	<I18nProvider>
		<QueryClientProvider client={queryClient}>
			<main className="mx-auto max-w-4xl p-8">
				<h1 className="mb-4 text-2xl font-semibold">ACP runtime settings</h1>
				<p className="mb-6 text-sm text-muted-foreground">
					Production settings component and SDK against a finite HTTP fixture.
					Hardware and active-agent counts are fixture projections; this does
					not start ACP processes or inhibit OS sleep.
				</p>
				<AcpRuntimeSection canConfigure={canConfigure} target={target} />
			</main>
			<Toaster position="bottom-right" theme="light" />
		</QueryClientProvider>
	</I18nProvider>
);
