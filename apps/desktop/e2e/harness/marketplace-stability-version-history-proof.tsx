import AppsCatalogSection from "@ryu/marketplace/catalog/apps";
import {
	type CatalogHost,
	CatalogHostProvider,
	type CatalogInstall,
} from "@ryu/marketplace/catalog/host";
import { InstalledOnlyProvider } from "@ryu/marketplace/catalog/installed-filter";
import type {
	AppCatalogItem,
	AppsCatalogState,
	CatalogEntry,
	PluginCatalogDetail,
} from "@ryu/marketplace/catalog/types";
import { Button } from "@ryu/ui/components/button.tsx";
import { createContext, useContext, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const DETAIL: PluginCatalogDetail = {
	description: "A proof listing with a stable release and a beta history.",
	id: "com.example.versioned-plugin",
	name: "Versioned Plugin",
	readme: "# Versioned Plugin\n\nA Marketplace preview proof.",
	repositoryUrl: "https://github.com/example/versioned-plugin",
	version: "2.0.0",
	versions: [
		{
			installable: true,
			stability: "stable",
			stabilityKnown: true,
			version: "2.0.0",
		},
		{
			installable: true,
			prerelease: true,
			stability: "beta",
			stabilityKnown: true,
			version: "1.5.0-beta.1",
		},
		{
			stabilityKnown: false,
			version: "1.0.0",
			tagOnly: true,
		},
	],
};

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
	return {
		description: "A stable Marketplace listing.",
		id: "com.example.versioned-plugin",
		kinds: ["tool"],
		name: "Versioned Plugin",
		tags: ["proof"],
		version: "2.0.0",
		...overrides,
	};
}

const STABLE_ITEM: AppCatalogItem = {
	enabled: true,
	entry: entry(),
	grants: [],
	installed: true,
};

const BETA_ITEM: AppCatalogItem = {
	enabled: false,
	entry: entry({
		description: "A beta Marketplace listing.",
		id: "com.example.beta-plugin",
		name: "Beta Plugin",
		stability: "beta",
	}),
	grants: [],
	installed: false,
};

interface ProofState {
	lastInstalledVersion: string | null;
	selectedId: string | null;
	setLastInstalledVersion: (version: string) => void;
	setSelectedId: (id: string | null) => void;
}

const ProofContext = createContext<ProofState | null>(null);

function useProofAppsCatalog(): AppsCatalogState {
	const proof = useContext(ProofContext);
	if (!proof) {
		throw new Error("proof catalog context is missing");
	}
	const items = [STABLE_ITEM, BETA_ITEM];
	const selectedItem =
		items.find((item) => item.entry.id === proof.selectedId) ?? null;
	return {
		activeSource: "ryu-marketplace",
		addingMarketplace: false,
		addMarketplace: async () => undefined,
		detail: selectedItem ? DETAIL : null,
		detailError: null,
		detailLoading: false,
		error: proof.lastInstalledVersion
			? `Installed ${proof.lastInstalledVersion}`
			: null,
		fetchNextPage: () => undefined,
		hasNextPage: false,
		install: async () => undefined,
		installFromUrl: async () => undefined,
		installVersion: async (_id, version) => {
			proof.setLastInstalledVersion(version.version);
		},
		installing: null,
		items,
		lifecyclePending: false,
		loading: false,
		loadingMore: false,
		query: "",
		select: (id) => proof.setSelectedId(id || null),
		selectedId: proof.selectedId,
		selectedItem,
		selectingSource: false,
		selectSource: () => undefined,
		setEnabled: async () => undefined,
		setQuery: () => undefined,
		sources: [{ displayName: "Ryu Marketplace", id: "ryu-marketplace" }],
	};
}

function useProofToggle(
	_key: string,
	defaultValue: boolean
): [boolean, (value: boolean) => void] {
	return useState(defaultValue);
}

const PROOF_INSTALL: CatalogInstall = {
	InstallButton: ({ children, onClick, installing }) => (
		<Button loading={installing} onClick={onClick} size="sm">
			{children}
		</Button>
	),
};

const PROOF_HOST: CatalogHost = {
	ActiveModelControl: () => null,
	Markdown: ({ content }) => <div>{content}</div>,
	estimateLlmfit: async () => ({
		fit_level: null,
		installed: false,
		matched: false,
		min_vram_gb: null,
		path: null,
		tps: null,
	}),
	fitStyle: () => ({ className: "", dot: "" }),
	install: PROOF_INSTALL,
	installSidecar: async () => undefined,
	openExternal: () => undefined,
	useActiveNode: () => ({ token: null, url: "" }),
	useAppsCatalog: useProofAppsCatalog,
	useInstalledModels: () => [],
	useModelCatalog: () => {
		throw new Error("models are not mounted in this proof");
	},
	usePersistedToggle: useProofToggle,
	useSkillsCatalog: () => {
		throw new Error("skills are not mounted in this proof");
	},
};

function ProofPage() {
	const [installedOnly, setInstalledOnly] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [lastInstalledVersion, setLastInstalledVersion] = useState<
		string | null
	>(null);
	return (
		<ProofContext.Provider
			value={{
				lastInstalledVersion,
				selectedId,
				setLastInstalledVersion,
				setSelectedId,
			}}
		>
			<CatalogHostProvider host={PROOF_HOST}>
				<InstalledOnlyProvider value={installedOnly}>
					<div className="flex min-h-screen flex-col bg-background text-foreground">
						<header className="flex items-center justify-between border-border border-b px-6 py-4">
							<div>
								<p className="font-semibold text-lg">Marketplace</p>
								<p className="text-muted-foreground text-sm">
									Apps and plugins
								</p>
							</div>
							<Button
								aria-pressed={installedOnly}
								onClick={() => setInstalledOnly((value) => !value)}
								variant={installedOnly ? "secondary" : "ghost"}
							>
								Installed only
							</Button>
						</header>
						<main className="min-h-0 flex-1 overflow-hidden">
							<AppsCatalogSection variant="plugins" />
						</main>
					</div>
				</InstalledOnlyProvider>
			</CatalogHostProvider>
		</ProofContext.Provider>
	);
}

createRoot(document.getElementById("root")!).render(<ProofPage />);
document.body.dataset.harnessReady = "1";
