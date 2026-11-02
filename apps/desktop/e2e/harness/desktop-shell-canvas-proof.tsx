import { I18nProvider } from "@ryu/i18n/react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import Layout from "../../src/components/layout/Layout.tsx";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import {
	prepareShellProof,
	ShellProofProviders,
} from "./shell-proof-providers.tsx";
import "../../src/index.css";
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });
useNodeStore.setState({
	autoSelect: false,
	defaultNode: "Tabs proof",
	nodes: [
		{
			name: "Tabs proof",
			url: location.origin,
			token: "tabs-fixture",
			userJwt: null,
		},
	],
});
await prepareShellProof();
// Layout mounts its own Tabs and ChatHistory providers; SignedInShell supplies
// the auth and entitlement layers above it.
createRoot(document.getElementById("root")!).render(
	<BrowserRouter>
		<I18nProvider>
			<ShellProofProviders
				auth
				entitlement
				queryClient={queryClient}
				surface="web"
			>
				<Layout />
			</ShellProofProviders>
		</I18nProvider>
	</BrowserRouter>
);
