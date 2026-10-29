import { Markdown } from "@ryu/blocks/desktop/agent-elements/markdown.tsx";
import { I18nProvider } from "@ryu/i18n/react";
import type {
	CatalogHost,
	CatalogInstallButtonProps,
} from "@ryu/marketplace/catalog/host";
import { CatalogHostProvider } from "@ryu/marketplace/catalog/host";
import { Button } from "@ryu/ui/components/button.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActiveModelControl } from "../../src/components/store/ActiveModelControl.tsx";
import type { useTabsContext } from "../../src/contexts/TabsContext.tsx";
import { useModelCatalog } from "../../src/hooks/useModelCatalog.ts";
import { usePersistedToggle } from "../../src/hooks/usePersistedToggle.ts";
import { estimateLlmfit } from "../../src/lib/api/models.ts";
import { installSidecar } from "../../src/lib/services-api.ts";
import StorePage from "../../src/pages/StorePage.tsx";
import { useActiveNode } from "./marketplace-store-mocks/active-node.ts";
import { DesktopMarketplaceHost } from "./marketplace-store-test-host.tsx";
import "../../src/index.css";

type OpenTabOptions = NonNullable<
	Parameters<ReturnType<typeof useTabsContext>["openTab"]>[1]
>;

declare global {
	interface Window {
		__modelsStoreEffects?: {
			openedTabOptions: OpenTabOptions[];
			openedTabs: string[];
		};
	}
}

function TestInstallButton({
	busyLabel = "Adding…",
	children,
	disabled,
	installing,
	onClick,
}: CatalogInstallButtonProps) {
	return (
		<Button
			aria-busy={installing}
			disabled={disabled || installing}
			onClick={onClick}
			size="sm"
		>
			{installing ? busyLabel : children}
		</Button>
	);
}

const catalogInstall = { InstallButton: TestInstallButton };
const catalogHost: CatalogHost = {
	ActiveModelControl,
	estimateLlmfit,
	fitStyle: () => ({ className: "", dot: "bg-success" }),
	install: catalogInstall,
	installSidecar,
	Markdown,
	navigate: (path) => {
		window.dispatchEvent(
			new CustomEvent("marketplace-store:tab", { detail: path })
		);
	},
	openExternal: (url) => {
		window.dispatchEvent(
			new CustomEvent("marketplace-store:external", { detail: url })
		);
	},
	useActiveNode,
	useAppsCatalog: () => {
		throw new Error("Apps catalog is outside the Models fixture");
	},
	useInstalledModels: () => [],
	useModelCatalog,
	usePersistedToggle,
	useSkillsCatalog: () => {
		throw new Error("Skills catalog is outside the Models fixture");
	},
};

function Harness() {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					mutations: { retry: false },
					queries: { retry: false, staleTime: 0 },
				},
			})
	);
	const [openedTabs, setOpenedTabs] = useState<string[]>([]);
	const [openedTabOptions, setOpenedTabOptions] = useState<OpenTabOptions[]>(
		[]
	);
	useEffect(() => {
		const recordTab = (event: Event) => {
			// SAFETY: This private tab observer receives the local catalogHost navigate(path) or the aliased tabs-context openTab(path); both publish their string path as detail. Foreign event dispatchers are outside this controlled fixture.
			const detail = (event as CustomEvent<string>).detail;
			setOpenedTabs((current) => [...current, detail]);
		};
		const recordTabOptions = (event: Event) => {
			// SAFETY: The fixture alias binds tabs-context openTab to the local publisher, whose options detail is its OpenTabOptions argument or an authored empty object. This does not validate foreign events.
			const detail = (event as CustomEvent<OpenTabOptions>).detail;
			setOpenedTabOptions((current) => [...current, detail]);
		};
		window.addEventListener("marketplace-store:tab", recordTab);
		window.addEventListener("marketplace-store:tab-options", recordTabOptions);
		return () => {
			window.removeEventListener("marketplace-store:tab", recordTab);
			window.removeEventListener(
				"marketplace-store:tab-options",
				recordTabOptions
			);
		};
	}, []);
	useEffect(() => {
		window.__modelsStoreEffects = { openedTabs, openedTabOptions };
	}, [openedTabs, openedTabOptions]);

	return (
		<I18nProvider packs={[]}>
			<QueryClientProvider client={queryClient}>
				<CatalogHostProvider host={catalogHost}>
					<DesktopMarketplaceHost>
						<div className="h-svh min-h-0 bg-background text-foreground">
							<StorePage initialSection="models" />
						</div>
						<Toaster position="bottom-right" theme="dark" />
					</DesktopMarketplaceHost>
				</CatalogHostProvider>
			</QueryClientProvider>
			<output
				aria-label="Models harness effects"
				className="sr-only"
				data-testid="models-harness-effects"
			>
				{JSON.stringify({ openedTabs })}
			</output>
		</I18nProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Marketplace Store Models harness root is missing");
}
createRoot(root).render(<Harness />);
