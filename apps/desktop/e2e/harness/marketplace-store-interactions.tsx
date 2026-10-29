import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SkillDistributionProvider } from "../../src/components/skills/SkillDistributionProvider.tsx";
import StorePage from "../../src/pages/StorePage.tsx";
import "../../src/index.css";

declare global {
	interface Window {
		__marketplaceStoreEffects?: {
			externalUrls: string[];
			openedTabs: string[];
			settingsOpened: string[];
		};
	}
}

function Harness() {
	const [effects, setEffects] = useState({
		externalUrls: [],
		openedTabs: [],
		settingsOpened: [],
	});
	useEffect(() => {
		const recordExternal = (event: Event) => {
			// SAFETY: The fixture Vite aliases bind this private external event to tauri-bridge openExternal(url) and the local marketplace test host; its publisher places the string argument in detail. Foreign event dispatchers are outside this controlled fixture.
			const detail = (event as CustomEvent<string>).detail;
			setEffects((current) => ({
				...current,
				externalUrls: [...current.externalUrls, detail],
			}));
		};
		const recordTab = (event: Event) => {
			// SAFETY: The fixture Vite aliases bind this private tab event to tabs-context openTab(path); its publisher places the string argument in detail. Foreign event dispatchers are outside this controlled fixture.
			const detail = (event as CustomEvent<string>).detail;
			setEffects((current) => ({
				...current,
				openedTabs: [...current.openedTabs, detail],
			}));
		};
		const recordSettings = (event: Event) => {
			// SAFETY: The fixture Vite aliases bind this private settings event to plugin-settings-opener callback capturing its string plugin ID; its publisher places the string argument in detail. Foreign event dispatchers are outside this controlled fixture.
			const detail = (event as CustomEvent<string>).detail;
			setEffects((current) => ({
				...current,
				settingsOpened: [...current.settingsOpened, detail],
			}));
		};
		window.addEventListener("marketplace-store:external", recordExternal);
		window.addEventListener("marketplace-store:tab", recordTab);
		window.addEventListener("marketplace-store:settings", recordSettings);
		return () => {
			window.removeEventListener("marketplace-store:external", recordExternal);
			window.removeEventListener("marketplace-store:tab", recordTab);
			window.removeEventListener("marketplace-store:settings", recordSettings);
		};
	}, []);
	useEffect(() => {
		window.__marketplaceStoreEffects = effects;
	}, [effects]);

	const initialSection =
		new URLSearchParams(window.location.search).get("section") ?? "agents";
	const queryClient = new QueryClient({
		defaultOptions: {
			mutations: { retry: false },
			queries: { retry: false, staleTime: 0 },
		},
	});
	return (
		<I18nProvider packs={[]}>
			<QueryClientProvider client={queryClient}>
				<div className="h-svh min-h-0 bg-background text-foreground">
					<SkillDistributionProvider>
						<StorePage initialSection={initialSection} />
					</SkillDistributionProvider>
				</div>
				<Toaster position="bottom-right" theme="dark" />
				<output
					aria-label="Harness effects"
					className="sr-only"
					data-testid="harness-effects"
				>
					{JSON.stringify(effects)}
				</output>
			</QueryClientProvider>
		</I18nProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Marketplace Store harness root is missing");
}
createRoot(root).render(<Harness />);
