import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { TtsEngineSettings } from "../../src/components/settings/TtsEngineSettings.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";
import { triggerGlobalRefresh } from "../../src/lib/core-refresh.ts";
const node = {
	name: "voice-outcomes",
	url: "http://127.0.0.1:5866",
	token: "finite-voice-outcomes-token",
};
useNodeStore.setState({
	localNodes: [node],
	nodes: [node],
	cloudNodes: [],
	defaultNode: node.name,
	autoSelect: false,
	autoSelectedNode: null,
	tabOverrides: {},
});
const authorityNodes = {
	a: node,
	b: {
		name: "voice-outcomes-b",
		url: "http://127.0.0.1:5866/b",
		token: "finite-voice-outcomes-token-b",
	},
	rotated: { ...node, token: "finite-voice-outcomes-token-rotated" },
};
Object.assign(window, {
	__voiceOutcomeAuthority: {
		select: (key: keyof typeof authorityNodes) => {
			const selected = authorityNodes[key];
			useNodeStore.setState({
				nodes: [selected],
				localNodes: [selected],
				defaultNode: selected.name,
				autoSelect: false,
				autoSelectedNode: null,
				tabOverrides: {},
			});
		},
		refreshAll: triggerGlobalRefresh,
		current: () => useNodeStore.getState().getActiveNode(),
	},
});
localStorage.setItem("ryu.tts.engine", "kokoro");
localStorage.setItem("ryu.tts.voice", "af_heart");
const query = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
createRoot(document.getElementById("root")!).render(
	<MemoryRouter>
		<QueryClientProvider client={query}>
			<AppSurfaceProvider surface="desktop">
				<I18nProvider>
					<I18nDirectionProvider>
						<ThemeProvider
							attribute="class"
							defaultTheme="dark"
							enableSystem={false}
						>
							<Toaster theme="dark" />
							<main className="min-h-dvh p-8">
								<TtsEngineSettings />
							</main>
						</ThemeProvider>
					</I18nDirectionProvider>
				</I18nProvider>
			</AppSurfaceProvider>
		</QueryClientProvider>
	</MemoryRouter>,
);
