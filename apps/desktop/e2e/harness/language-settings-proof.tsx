import "../../src/index.css";
import { useI18n } from "@ryu/i18n/react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation } from "react-router-dom";
import { LanguagePackBridge } from "@/src/components/LanguagePackBridge.tsx";
import { LanguageSettings } from "@/src/components/settings/LanguageSettings.tsx";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

// The only host setup is a real loopback HTTP target. Components, hooks,
// localStorage, browser storage events, router, and translation runtime ship.
useNodeStore.setState({
	autoSelect: false,
	defaultNode: "language-proof",
	nodes: [
		{
			name: "language-proof",
			url: window.location.origin,
			token: "language-proof-node",
		},
	],
});
function Consumer() {
	const { locale, t } = useI18n();
	const location = useLocation();
	return (
		<>
			<input aria-label="Unsent language proof draft" defaultValue="" />
			<output data-testid="language-consumer">
				{locale}:{t("common.install")}
			</output>
			<output data-testid="language-location">{location.pathname}</output>
		</>
	);
}
createRoot(document.getElementById("root")!).render(
	<BrowserRouter>
		<LanguagePackBridge>
			<LanguageSettings />
			<Consumer />
		</LanguagePackBridge>
	</BrowserRouter>
);
