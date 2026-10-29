import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { PrivacySettings } from "../../src/components/settings/PrivacySettings.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import "../../src/index.css";

interface ProofWindow extends Window {
	__proofOpenExternal?: string;
	__TAURI_INTERNALS__?: {
		invoke: (command: string, args?: { url?: string }) => Promise<null>;
		transformCallback: () => number;
	};
}

// SAFETY: This private write view installs the two authored bridge callbacks below; the only external URL write follows isNativeText(args?.url). It does not describe a public Tauri result ABI.
const proofWindow = window as ProofWindow;
proofWindow.__TAURI_INTERNALS__ = {
	invoke: async (command, args) => {
		if (command === "open_external" && isNativeText(args?.url)) {
			proofWindow.__proofOpenExternal = args.url;
		}
		return null;
	},
	transformCallback: () => 0,
};

function ProofSurface() {
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
				<I18nProvider>
					<I18nDirectionProvider>
						<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
							<Toaster position="bottom-right" theme="dark" />
							<main
								className="min-h-dvh bg-background p-8 text-foreground"
								data-testid="privacy-settings-proof"
							>
								<div className="mx-auto flex max-w-5xl flex-col gap-6">
									<header className="rounded-2xl border bg-card p-6 shadow-sm">
										<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
											Desktop settings verification
										</p>
										<h1 className="mt-2 font-semibold text-2xl">
											Privacy &amp; data
										</h1>
										<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
											Consent, diagnostics export, support access, and
											self-healing settings rendered from the Desktop product
											components.
										</p>
									</header>
									<section className="rounded-2xl border bg-card p-6 shadow-sm">
										<PrivacySettings />
									</section>
								</div>
							</main>
						</ThemeProvider>
					</I18nDirectionProvider>
				</I18nProvider>
			</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<MemoryRouter>
			<ProofSurface />
		</MemoryRouter>
	);
}
