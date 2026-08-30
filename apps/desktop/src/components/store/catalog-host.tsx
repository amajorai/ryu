// apps/desktop/src/components/store/catalog-host.tsx
//
// Desktop binding for the shared @ryu/marketplace catalog sections (apps / models
// / skills). Supplies the Core-node-scoped data hooks, the install-progress
// button, the app Markdown renderer, and Tauri's `openExternal` through the
// CatalogHost seam. `navigate` deep-links into a new tab, which the shared Skills
// section pairs with `canAuthorSkills` to unlock its SKILL.md authoring UI, and the
// Models section uses for the "Fine-tune this model" handoff. The hook functions the
// host carries are stable module refs, so the section's `host.use*Catalog(...)` call
// resolves to the same hook every render (rules of hooks); only `navigate` and the
// authoring bit re-key the memoized host. Web mounts its own read-only host with
// `install: null`.

import { Markdown } from "@ryu/blocks/desktop/agent-elements/markdown.tsx";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button.tsx";
import { fitStyle } from "@ryu/blocks/desktop/model-catalog.tsx";
import { DependencyLookupProvider } from "@ryu/marketplace/catalog/detail/dependency-graph";
import {
	type CatalogHost,
	CatalogHostProvider,
	type CatalogInstallButtonProps,
	type CatalogNode,
} from "@ryu/marketplace/catalog/host";
import type {
	InstalledModelEntry,
	Surface,
} from "@ryu/marketplace/catalog/types";
import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useSkillDistributionFlow } from "@/src/components/skills/SkillDistributionProvider.tsx";
import { ActiveModelControl } from "@/src/components/store/ActiveModelControl.tsx";
import { useDesktopDependencyLookup } from "@/src/components/store/dependency-lookup.ts";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { SKILL_EDITOR_ALIAS } from "@/src/contributions/companion-alias.ts";
import { useCompanionAlias } from "@/src/contributions/use-companion-alias.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAppsCatalog } from "@/src/hooks/useAppsCatalog.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { useModelCatalog } from "@/src/hooks/useModelCatalog.ts";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { usePluginSettingsOpener } from "@/src/hooks/usePluginSettingsOpener.ts";
import { useSkillPacks } from "@/src/hooks/useSkillPacks.ts";
import { useSkillsCatalog } from "@/src/hooks/useSkillsCatalog.ts";
import { fetchEntitlementSnapshot } from "@/src/lib/api/billing.ts";
import { runCatalogScan } from "@/src/lib/api/catalog-scan.ts";
import type { DownloadKind } from "@/src/lib/api/downloads.ts";
import { estimateLlmfit, listInstalledModels } from "@/src/lib/api/models.ts";
import {
	fetchPluginChannels,
	fetchPluginVersionDetail,
} from "@/src/lib/api/plugins.ts";
import { installSidecar } from "@/src/lib/services-api.ts";
import { useInstallProgress } from "@/src/store/useDownloadsStore.ts";
import { useInstallingLookup } from "@/src/store/useInstallStore.ts";

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
		progress.name,
		progress.taskId
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

/** The desktop's shared install state, exposed to the shared sections through the
 *  install seam. Module-level (like {@link DesktopInstallButton}) so the memoized
 *  host never hands the sections a new hook identity on a node switch. */
const desktopInstall = {
	InstallButton: DesktopInstallButton,
	useInstallingLookup,
};

/** Active node identity, normalized to the shared seam's `{url, token}` shape. */
function useCatalogNode(): CatalogNode {
	const node = useActiveNode();
	return { url: node.url, token: node.token, userJwt: node.userJwt ?? null };
}

/** Installed models by stem for the active node (fine-tuned-variants list). */
function useInstalledModels(): InstalledModelEntry[] {
	const node = useActiveNode();
	const query = useQuery({
		queryKey: ["models", "installed", node.url],
		queryFn: () =>
			listInstalledModels({
				url: node.url,
				token: node.token,
				userJwt: node.userJwt ?? null,
			}),
	});
	return query.data ?? [];
}

/** The host-surface versions THIS client can vouch for.
 *
 *  Core computes a compatibility verdict for every listing, but it can only see
 *  its own version and the Gateway's — it reports a `desktop` floor as an advisory
 *  `unknown` because a desktop install never reports in. So without this, a
 *  `desktop: ">=2.0.0"` floor is inert on the one client that knows the answer.
 *
 *  Only `desktop` is claimed. The island runs out-of-process and the desktop knows
 *  only whether it is REACHABLE, not its version, so claiming one would be a guess
 *  — and a wrong guess here silently blocks an install. Unknown stays advisory. */
function useDesktopHostVersions(): Partial<Record<Surface, string>> {
	const [version, setVersion] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		getVersion()
			.then((v) => {
				if (!cancelled) {
					setVersion(v);
				}
			})
			// A version we cannot read is UNKNOWN, not old: swallow and stay advisory
			// rather than let a failed lookup grey out every listing.
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);
	// Memoised so the object identity is stable — `useEntryIncompatibility` keys its
	// own memo on it, and a fresh `{}` each render would recompute for every card.
	return useMemo(() => (version ? { desktop: version } : {}), [version]);
}

/** Resolve the Marketplace plan marker for the shared catalog's ticket badge.
 * This is presentation-only; lifecycle actions never read this result. */
function useMarketplaceAccess(): boolean {
	const query = useQuery({
		queryKey: ["billing", "marketplace-access"],
		queryFn: async () =>
			Boolean((await fetchEntitlementSnapshot())?.entitlement?.marketplaceApps),
		staleTime: 60_000,
	});
	return query.data ?? false;
}

/** Mount once above every store surface that renders the shared catalog sections. */
export function DesktopCatalogHost({ children }: { children: ReactNode }) {
	const activeNode = useCatalogNode();
	const { openTab } = useTabsContext();
	const { distributeInstalledSkill } = useSkillDistributionFlow();
	const navigate = useCallback(
		(path: string) => {
			openTab(path);
		},
		[openTab]
	);

	// Whether the SKILL.md editor app is live. `navigate` alone only proves desktop
	// CAN open a tab; `@ryu/skill-editor` is not pre-installed, so without this the
	// Skills section rendered New/Edit on every card and each opened "App not
	// enabled". Read from the live contributions feed — the same source the
	// `/skills/new` + `/skills/:id/edit` routes mount from — so the button and the
	// page it opens can never disagree.
	const skillEditorOwner = useCompanionAlias(SKILL_EDITOR_ALIAS);

	// Node-scoped answer to "is this dependency already here?", read by the shared
	// Dependencies tab through its own context rather than the host object: the
	// host must stay a stable module-shaped value (rules of hooks), and this is
	// live query data that changes as apps are installed and enabled.
	const dependencyLookup = useDesktopDependencyLookup();

	// What this client knows about its own surfaces, overlaid on Core's verdict so
	// a per-surface floor is enforceable rather than merely declared.
	const hostVersions = useDesktopHostVersions();

	const host = useMemo<CatalogHost>(
		() => ({
			canAuthorSkills: skillEditorOwner !== null,
			distributeSkill: async (skillId) => {
				await distributeInstalledSkill(skillId);
			},
			install: desktopInstall,
			Markdown,
			// Reads the listing's repo at a version tag. Bound to the active node
			// here so the shared panel stays node-agnostic, matching how
			// `estimateLlmfit` is bound below.
			fetchVersionDetail: (repo: string, tag: string) =>
				fetchPluginVersionDetail(
					{
						url: activeNode.url,
						token: activeNode.token,
						userJwt: activeNode.userJwt,
					},
					repo,
					tag
				),
			// The release trains a listing publishes. Bound to the active node for the
			// same reason as `fetchVersionDetail`: the node resolves them (from the
			// marketplace for an installable train, from the repository's tags for a
			// browse-only one), so switching nodes must switch the answer.
			fetchListingChannels: (id: string, repo?: string | null) =>
				fetchPluginChannels(
					{
						url: activeNode.url,
						token: activeNode.token,
						userJwt: activeNode.userJwt,
					},
					id,
					repo
				),
			navigate,
			openExternal,
			runCatalogScan: (input) =>
				runCatalogScan(
					{
						url: activeNode.url,
						token: activeNode.token,
						userJwt: activeNode.userJwt,
					},
					input
				),
			useAppsCatalog,
			useMarketplaceAccess,
			useSkillsCatalog,
			useModelCatalog,
			useSkillPacks,
			useActiveNode: useCatalogNode,
			// A module-level hook, like `usePersistedToggle` beside it — so it adds no
			// memo dependency and the host object stays stable across renders, which
			// this file's own header says twice is load-bearing.
			useInterfaceLevel,
			usePersistedToggle,
			// Lets a Store listing lead to its own settings tab (Gateway dialog for
			// node-scoped tabs, App Settings for user-scoped ones) instead of leaving
			// the user to find it. Web omits this and the affordance never renders.
			usePluginSettingsOpener,
			installSidecar,
			estimateLlmfit: (node, repo, options) =>
				estimateLlmfit(
					{
						url: node.url,
						token: node.token,
						userJwt: node.userJwt,
					},
					repo,
					options
				),
			useInstalledModels,
			ActiveModelControl,
			fitStyle,
			hostVersions,
		}),
		// activeNode is a dep because fetchVersionDetail closes over it — without
		// it, switching nodes would keep reading versions from the previous one.
		[
			navigate,
			skillEditorOwner,
			distributeInstalledSkill,
			activeNode.url,
			activeNode.token,
			activeNode.userJwt,
			hostVersions,
		]
	);

	return (
		<CatalogHostProvider host={host}>
			{/* Lets the Dependencies tab resolve declared ids against THIS node —
			    names, install/enable state, and each dependency's own dependencies.
			    Web mounts no lookup, so its tab degrades to the declared list. */}
			<DependencyLookupProvider lookup={dependencyLookup}>
				{children}
			</DependencyLookupProvider>
		</CatalogHostProvider>
	);
}
