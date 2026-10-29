import { Markdown } from "@ryu/blocks/desktop/agent-elements/markdown.tsx";
import { I18nProvider } from "@ryu/i18n/react";
import type {
	CatalogHost,
	CatalogInstallButtonProps,
} from "@ryu/marketplace/catalog/host";
import { CatalogHostProvider } from "@ryu/marketplace/catalog/host";
import { ReportProvider } from "@ryu/marketplace/report";
import { Button } from "@ryu/ui/components/button.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	SkillDistributionProvider,
	useSkillDistributionFlow,
} from "../../src/components/skills/SkillDistributionProvider.tsx";
import { ActiveModelControl } from "../../src/components/store/ActiveModelControl.tsx";
import { useAppsCatalog } from "../../src/hooks/useAppsCatalog.ts";
import { useModelCatalog } from "../../src/hooks/useModelCatalog.ts";
import { usePersistedToggle } from "../../src/hooks/usePersistedToggle.ts";
import { useSkillPacks } from "../../src/hooks/useSkillPacks.ts";
import { useSkillsCatalog } from "../../src/hooks/useSkillsCatalog.ts";
import { runCatalogScan } from "../../src/lib/api/catalog-scan.ts";
import { estimateLlmfit } from "../../src/lib/api/models.ts";
import {
	fetchPluginChannels,
	fetchPluginVersionDetail,
} from "../../src/lib/api/plugins.ts";
import { installSidecar } from "../../src/lib/services-api.ts";
import StorePage from "../../src/pages/StorePage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import type { StoreHomeEffects } from "../marketplace-store-home-proof.contracts.ts";
import {
	storeReportEventDetail,
	storeStringEventDetail,
} from "../marketplace-store-home-proof.contracts.ts";
import { useActiveNode } from "./marketplace-store-mocks/active-node.ts";
import { DesktopMarketplaceHost } from "./marketplace-store-test-host.tsx";
import "../../src/index.css";

const fixtureNode = {
	name: "Local Marketplace fixture",
	token: "fixture-node-token",
	url: window.location.origin,
};
useNodeStore.setState({
	defaultNode: fixtureNode.name,
	getActiveNode: () => fixtureNode,
	nodes: [fixtureNode],
});

const catalogInstall = {
	InstallButton: ({
		busyLabel = "Adding…",
		children,
		disabled,
		installing,
		onClick,
	}: CatalogInstallButtonProps) => (
		<Button
			aria-busy={installing}
			disabled={disabled || installing}
			onClick={onClick}
			size="sm"
		>
			{installing ? busyLabel : children}
		</Button>
	),
};

const catalogHost: CatalogHost = {
	ActiveModelControl,
	estimateLlmfit,
	fitStyle: () => ({ className: "", dot: "bg-success" }),
	fetchListingChannels: (id, repo) =>
		fetchPluginChannels(
			{
				token: "fixture-node-token",
				url: window.location.origin,
			},
			id,
			repo
		),
	fetchVersionDetail: (repo, tag) =>
		fetchPluginVersionDetail(
			{
				token: "fixture-node-token",
				url: window.location.origin,
			},
			repo,
			tag
		),
	install: catalogInstall,
	installSidecar,
	Markdown,
	openAuditConversation: (id) =>
		window.dispatchEvent(
			new CustomEvent("marketplace-store:audit-conversation", { detail: id })
		),
	navigate: (path) => {
		window.dispatchEvent(
			new CustomEvent("marketplace-store:tab", { detail: path })
		);
	},
	canAuthorSkills: true,
	runCatalogScan: (input) =>
		runCatalogScan(
			{
				token: "fixture-node-token",
				url: window.location.origin,
			},
			input
		),
	openExternal: (url) => {
		window.dispatchEvent(
			new CustomEvent("marketplace-store:external", { detail: url })
		);
	},
	useActiveNode,
	useAppsCatalog,
	useInstalledModels: () => [],
	useModelCatalog,
	usePersistedToggle,
	usePluginSettingsOpener: () => (id) =>
		id === "fixture/home-plugin"
			? () => {
					window.dispatchEvent(
						new CustomEvent("marketplace-store:settings", { detail: id })
					);
				}
			: null,
	useSkillsCatalog,
	useSkillPacks,
};

function CatalogHostBridge({ children }: { children: ReactNode }) {
	const { distributeInstalledSkill } = useSkillDistributionFlow();
	const host = useMemo<CatalogHost>(
		() => ({
			...catalogHost,
			distributeSkill: async (skillId) => {
				await distributeInstalledSkill(skillId);
			},
		}),
		[distributeInstalledSkill]
	);
	return <CatalogHostProvider host={host}>{children}</CatalogHostProvider>;
}

window.__marketplaceHomeDecodeStringEvent = storeStringEventDetail;

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
	const [openedExternalUrls, setOpenedExternalUrls] = useState<string[]>([]);
	const [openedSettings, setOpenedSettings] = useState<string[]>([]);
	const [openedAuditConversations, setOpenedAuditConversations] = useState<
		string[]
	>([]);
	const [submittedReports, setSubmittedReports] = useState<
		StoreHomeEffects["submittedReports"]
	>([]);
	useEffect(() => {
		const recordTab = (event: Event) => {
			const detail = storeStringEventDetail(event);
			setOpenedTabs((current) => [...current, detail]);
		};
		const recordExternal = (event: Event) => {
			const detail = storeStringEventDetail(event);
			setOpenedExternalUrls((current) => [...current, detail]);
		};
		const recordSettings = (event: Event) => {
			const detail = storeStringEventDetail(event);
			setOpenedSettings((current) => [...current, detail]);
		};
		const recordReport = (event: Event) => {
			const detail = storeReportEventDetail(event);
			setSubmittedReports((current) => [...current, detail]);
		};
		const recordAuditConversation = (event: Event) => {
			const detail = storeStringEventDetail(event);
			setOpenedAuditConversations((current) => [...current, detail]);
		};
		window.addEventListener("marketplace-store:tab", recordTab);
		window.addEventListener("marketplace-store:external", recordExternal);
		window.addEventListener("marketplace-store:settings", recordSettings);
		window.addEventListener("marketplace-store:report", recordReport);
		window.addEventListener(
			"marketplace-store:audit-conversation",
			recordAuditConversation
		);
		return () => {
			window.removeEventListener("marketplace-store:tab", recordTab);
			window.removeEventListener("marketplace-store:external", recordExternal);
			window.removeEventListener("marketplace-store:settings", recordSettings);
			window.removeEventListener("marketplace-store:report", recordReport);
			window.removeEventListener(
				"marketplace-store:audit-conversation",
				recordAuditConversation
			);
		};
	}, []);
	useEffect(() => {
		window.__marketplaceHomeEffects = {
			openedExternalUrls,
			openedAuditConversations,
			openedSettings,
			openedTabs,
			submittedReports,
		};
	}, [
		openedExternalUrls,
		openedAuditConversations,
		openedSettings,
		openedTabs,
		submittedReports,
	]);
	const initialSection =
		new URLSearchParams(window.location.search).get("section") ?? "home";

	return (
		<I18nProvider packs={[]}>
			<QueryClientProvider client={queryClient}>
				<SkillDistributionProvider>
					<ReportProvider
						onSubmit={async (input) => {
							window.dispatchEvent(
								new CustomEvent("marketplace-store:report", { detail: input })
							);
							return {};
						}}
					>
						<CatalogHostBridge>
							<DesktopMarketplaceHost>
								<div className="h-svh min-h-0 bg-background text-foreground">
									<StorePage initialSection={initialSection} />
								</div>
								<Toaster position="bottom-right" theme="dark" />
							</DesktopMarketplaceHost>
						</CatalogHostBridge>
					</ReportProvider>
				</SkillDistributionProvider>
			</QueryClientProvider>
			<output
				aria-label="Marketplace Home harness effects"
				className="sr-only"
				data-testid="marketplace-home-effects"
			>
				{JSON.stringify({
					openedExternalUrls,
					openedAuditConversations,
					openedSettings,
					openedTabs,
					submittedReports,
				})}
			</output>
		</I18nProvider>
	);
}

declare global {
	interface Window {
		__marketplaceHomeDecodeStringEvent?: typeof storeStringEventDetail;
		__marketplaceHomeEffects?: StoreHomeEffects;
	}
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Marketplace Store Home harness root is missing");
}
createRoot(root).render(<Harness />);
