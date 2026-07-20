// apps/desktop/src/components/store/catalog-host.tsx
//
// Desktop binding for the shared @ryu/marketplace catalog sections (apps / models
// / skills). Supplies the Core-node-scoped data hooks, the install-progress
// button, the app Markdown renderer, and Tauri's `openExternal` through the
// CatalogHost seam. `navigate` deep-links into a new tab, which the shared Skills
// section uses to unlock its SKILL.md authoring UI, and the Models section uses
// for the "Fine-tune this model" handoff. The hook functions the host carries are
// stable module refs, so the section's `host.use*Catalog(...)` call resolves to
// the same hook every render (rules of hooks); only `navigate` re-keys the
// memoized host. Web mounts its own read-only host with `install: null`.

import { Markdown } from "@ryu/blocks/desktop/agent-elements/markdown";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button";
import { fitStyle } from "@ryu/blocks/desktop/model-catalog";
import {
	type CatalogHost,
	CatalogHostProvider,
	type CatalogInstallButtonProps,
	type CatalogNode,
} from "@ryu/marketplace/catalog/host";
import type { InstalledModelEntry } from "@ryu/marketplace/catalog/types";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo } from "react";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { ActiveModelControl } from "@/src/components/store/ActiveModelControl.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAppsCatalog } from "@/src/hooks/useAppsCatalog.ts";
import { useModelCatalog } from "@/src/hooks/useModelCatalog.ts";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { useSkillsCatalog } from "@/src/hooks/useSkillsCatalog.ts";
import type { DownloadKind } from "@/src/lib/api/downloads.ts";
import { estimateLlmfit, listInstalledModels } from "@/src/lib/api/models.ts";
import { installSidecar } from "@/src/lib/services-api.ts";
import { useInstallProgress } from "@/src/store/useDownloadsStore.ts";

/** The install button the shared sections render, wired to the desktop downloads
 *  store: it looks up the live percent for the item and renders the progress
 *  button. Kept out of the shared package so no catalog component imports the
 *  desktop store directly. */
function DesktopInstallButton({
	installing,
	onClick,
	children,
	progress,
	disabled,
	idleVariant,
	busyLabel,
}: CatalogInstallButtonProps) {
	const { percent } = useInstallProgress(
		progress.kinds as DownloadKind[],
		progress.name
	);
	return (
		<InstallProgressButton
			busyLabel={busyLabel}
			disabled={disabled}
			idleVariant={idleVariant}
			installing={installing}
			onClick={onClick}
			percent={percent}
		>
			{children}
		</InstallProgressButton>
	);
}

/** Active node identity, normalized to the shared seam's `{url, token}` shape. */
function useCatalogNode(): CatalogNode {
	const node = useActiveNode();
	return { url: node.url, token: node.token ?? null };
}

/** Installed models by stem for the active node (fine-tuned-variants list). */
function useInstalledModels(): InstalledModelEntry[] {
	const node = useActiveNode();
	const query = useQuery({
		queryKey: ["models", "installed", node.url],
		queryFn: () =>
			listInstalledModels({ url: node.url, token: node.token ?? null }),
	});
	return query.data ?? [];
}

/** Mount once above every store surface that renders the shared catalog sections. */
export function DesktopCatalogHost({ children }: { children: ReactNode }) {
	const { openTab } = useTabsContext();
	const navigate = useCallback(
		(path: string) => {
			openTab(path);
		},
		[openTab]
	);

	const host = useMemo<CatalogHost>(
		() => ({
			install: { InstallButton: DesktopInstallButton },
			Markdown,
			navigate,
			openExternal,
			useAppsCatalog,
			useSkillsCatalog,
			useModelCatalog,
			useActiveNode: useCatalogNode,
			usePersistedToggle,
			installSidecar,
			estimateLlmfit: (node, repo) =>
				estimateLlmfit({ url: node.url, token: node.token }, repo),
			useInstalledModels,
			ActiveModelControl,
			fitStyle,
		}),
		[navigate]
	);

	return <CatalogHostProvider host={host}>{children}</CatalogHostProvider>;
}
