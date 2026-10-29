import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { LanguagePackBridge } from "../../src/components/LanguagePackBridge.tsx";
import { AppearanceTab } from "../../src/components/settings/AppearanceTab.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { initTheme } from "../../src/hooks/useThemePreset.ts";
import { appearanceLanguageRequestsSchema } from "../appearance-proof.contracts.ts";
import "../../src/index.css";

const disabledLanguagePack = {
	baseLocale: "en",
	direction: "ltr",
	enabled: false,
	id: "proof/disabled-voice",
	locale: "fr-CA",
	messages: { "common.export": "Exporter" },
	name: "Coverage disabled voice",
	schemaVersion: 1,
	version: "1.0.0",
} as const;

const importedLanguagePack = {
	baseLocale: "en",
	direction: "ltr",
	enabled: true,
	id: "proof/imported-voice",
	locale: "en",
	messages: { "common.marketplace": "Marketplace" },
	name: "Coverage imported voice",
	schemaVersion: 1,
	version: "1.0.0",
} as const;

function installAppearanceProofApi(): () => void {
	const nativeFetch = Object.assign(window.fetch.bind(window), {
		preconnect: window.fetch.preconnect,
	});
	let disabledPackEnabled = false;
	// Core's import installs and activates the pack, so its installed catalog
	// lists the pack from then on. The Bridge reads that catalog back rather
	// than trusting the import response.
	let importedPackInstalled = false;
	window.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			const requestUrl = new URL(url, window.location.href);
			if (
				requestUrl.pathname === "/api/language-packs/installed" ||
				requestUrl.pathname === "/api/language-packs/import" ||
				requestUrl.pathname.startsWith(
					"/api/marketplace/packages/language_pack/"
				)
			) {
				const logKey = "ryu_appearance_language_requests";
				const requests = appearanceLanguageRequestsSchema.parse(
					JSON.parse(window.localStorage.getItem(logKey) ?? "[]")
				);
				requests.push({
					method: init?.method ?? "GET",
					path: requestUrl.pathname,
				});
				window.localStorage.setItem(logKey, JSON.stringify(requests));
			}
			if (requestUrl.pathname === "/api/language-packs/installed") {
				return Response.json({
					packs: [
						{
							...disabledLanguagePack,
							enabled: disabledPackEnabled,
						},
						...(importedPackInstalled ? [importedLanguagePack] : []),
					],
				});
			}
			if (requestUrl.pathname === "/api/language-packs/import") {
				importedPackInstalled = true;
				return Response.json({ pack: importedLanguagePack });
			}
			if (
				requestUrl.pathname ===
				"/api/marketplace/packages/language_pack/proof%2Fdisabled-voice/enable"
			) {
				disabledPackEnabled = true;
				return Response.json({ enabled: true });
			}
			if (requestUrl.pathname === "/api/plugins") {
				return Response.json({ apps: [] });
			}
			if (requestUrl.pathname === "/api/plugins/contributions") {
				return Response.json({});
			}
			return nativeFetch(input, init);
		},
		{ preconnect: nativeFetch.preconnect }
	);
	return () => {
		window.fetch = nativeFetch;
	};
}

function ProofSurface() {
	const location = useLocation();
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false } },
			}),
		[]
	);
	return (
		<QueryClientProvider client={queryClient}>
			<AppSurfaceProvider surface="desktop">
				<LanguagePackBridge>
					<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
						<AppearanceBoot />
						<Toaster position="bottom-right" theme="dark" />
						<main
							className="min-h-dvh bg-background p-8 text-foreground"
							data-testid="appearance-settings-proof"
						>
							<div className="mx-auto flex max-w-6xl flex-col gap-6">
								<header className="rounded-2xl border bg-card p-6 shadow-sm">
									<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
										Desktop settings verification
									</p>
									<h1 className="mt-2 font-semibold text-2xl">Appearance</h1>
									<p className="mt-2 text-muted-foreground text-sm">
										Theme, motion, information density, diffs, and file tree.
									</p>
								</header>
								<output className="sr-only" data-testid="proof-route">
									{location.pathname}
								</output>
								<section className="rounded-2xl border bg-card p-6 shadow-sm">
									<AppearanceTab />
								</section>
							</div>
						</main>
					</ThemeProvider>
				</LanguagePackBridge>
			</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

function AppearanceBoot() {
	useEffect(() => {
		// Match the production App boot effect: the isolated proof mounts the real
		// settings component without the rest of App, so it must still apply the
		// persisted custom preset before a reload assertion can prove visual restore.
		initTheme();
	}, []);
	return null;
}

installAppearanceProofApi();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<MemoryRouter>
			<ProofSurface />
		</MemoryRouter>
	);
}
