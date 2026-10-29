import { Button } from "@ryu/ui/components/button.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { SpaceProjectFolder } from "@/src/components/library/SpaceProjectFolder.tsx";
import { BackupSettings } from "@/src/components/settings/BackupSettings.tsx";
import { AppSurfaceProvider } from "@/src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "@/src/contexts/entitlement-context.tsx";
import {
	SpacesProvider,
	useSpacesContext,
} from "@/src/contexts/SpacesContext.tsx";
import { TabsProvider } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useMentionableResources } from "@/src/hooks/useMentionableResources.ts";
import { queryClient } from "@/src/lib/query-client.ts";
import SpacesPage from "@/src/pages/SpacesPage.tsx";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import proofStyles from "./spaces-performance-proof.module.css";
import "../../src/index.css";
useNodeStore.setState({
	nodes: [
		{
			name: "Alpha",
			url: "http://127.0.0.1:5212/alpha",
			token: null,
			userJwt: null,
		},
		{
			name: "Beta",
			url: "http://127.0.0.1:5212/beta",
			token: null,
			userJwt: null,
		},
	],
	defaultNode: "Alpha",
	autoSelect: false,
});
function MentionReader() {
	const resources = useMentionableResources([]);
	return (
		<output aria-label="Mention pages">
			{resources.pages.length} mention pages
		</output>
	);
}
function Shell() {
	const node = useActiveNode();
	const { reload, spaces } = useSpacesContext();
	return (
		<main className="h-screen">
			{location.search.includes("mentions") && (
				<QueryClientProvider client={queryClient}>
					<MentionReader />
				</QueryClientProvider>
			)}
			<header className="flex items-center gap-3 border-b p-4">
				<h1 className="mr-auto font-semibold text-xl">
					Spaces · <span>{spaces[0]?.name}</span>
				</h1>
				<Button onClick={() => useNodeStore.setState({ defaultNode: "Alpha" })}>
					Alpha node
				</Button>
				<Button onClick={() => useNodeStore.setState({ defaultNode: "Beta" })}>
					Beta node
				</Button>
				<Button onClick={() => void reload()}>Refresh list</Button>
			</header>
			{location.search.includes("backups") ? (
				<div className="p-8">
					<BackupSettings
						target={{
							url: node.url,
							token: node.token ?? null,
							userJwt: node.userJwt ?? null,
						}}
					/>
				</div>
			) : location.search.includes("previews") ? (
				<div className="p-8">
					{location.search.includes("offscreen") && (
						<div aria-hidden="true" className={proofStyles.fixture1} />
					)}
					{spaces.map((space) => (
						<SpaceProjectFolder
							favorited={false}
							key={space.id}
							onToggleFavorite={() => undefined}
							space={space}
						/>
					))}
				</div>
			) : (
				<SpacesPage />
			)}
		</main>
	);
}
createRoot(document.getElementById("root")!).render(
	<AppSurfaceProvider surface="desktop">
		<EntitlementProvider>
			<TabsProvider>
				<SpacesProvider>
					<Shell />
				</SpacesProvider>
			</TabsProvider>
		</EntitlementProvider>
	</AppSurfaceProvider>
);
