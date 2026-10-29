import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { asGlyphValue } from "@ryu/ui/components/glyph.ts";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { ResourceVisibilityConfirmationDialog } from "@/src/components/layout/ResourceVisibilityConfirmationDialog.tsx";
import type { EntityRow } from "@/src/components/layout/tab-entity-menu.tsx";
import { AddToSpaceDialog } from "@/src/components/spaces/AddToSpaceDialog.tsx";
import { DestructiveConfirmDialog } from "@/src/components/ui/DestructiveConfirmDialog.tsx";
import { AppSurfaceProvider } from "@/src/contexts/app-surface-context.tsx";
import { type Tab, TabsContext } from "@/src/contexts/TabsContext.tsx";
import type { Space } from "@/src/lib/api/spaces.ts";
import {
	deleteSpace,
	renameSpace,
	setSpaceIcon as saveSpaceIcon,
	setSpaceVisibility,
} from "@/src/lib/api/spaces.ts";
import {
	resourceVisibilityForGroup,
	type VisibilityChangeRequest,
} from "@/src/lib/resource-visibility.ts";
import { SpaceScopeMenu } from "../../src/components/layout/AppSidebar.tsx";
import { openEntityInNewWindow } from "../../src/lib/window-routing.ts";
import { createTabsProofContext } from "./tabs-proof-context.ts";
import "../../src/index.css";

const STORAGE_KEY = "proof:space-scope-menu-state";

interface ProofTab {
	icon: GlyphValue;
	id: string;
	path: string;
	title: string;
}

interface PersistedModel {
	deleteCalls: number;
	lastError: string;
	lastPluginAction: string;
	navigationPath: string;
	reloadCount: number;
	scenario: "default" | "restricted" | "system";
	space: Space | null;
	tabs: ProofTab[];
	visibilityRequest: VisibilityChangeRequest | null;
}

const GlyphSchema = z.json().transform((value) => asGlyphValue(value) ?? null);
const VisibilityRequestSchema = z.object({
	from: z.enum(["private", "team"]),
	to: z.enum(["private", "team"]),
	id: z.string(),
	name: z.string(),
	resourceType: z.enum(["chat", "space"]),
});
const SpaceSchema = z.object({
	createdAt: z.number(),
	description: z.string().nullable(),
	documentCount: z.number(),
	icon: GlyphSchema,
	id: z.string(),
	name: z.string(),
	retrievalMode: z.enum(["graph", "vector"]),
	system: z.boolean(),
	updatedAt: z.number(),
	visibility: z.enum(["org", "private", "team"]).optional(),
	teamId: z.string().nullable().optional(),
});
const ModelSchema = z.object({
	deleteCalls: z.number(),
	lastError: z.string(),
	lastPluginAction: z.string(),
	navigationPath: z.string(),
	reloadCount: z.number(),
	scenario: z.enum(["default", "restricted", "system"]),
	space: SpaceSchema.nullable(),
	tabs: z.array(
		z.object({
			icon: GlyphSchema,
			id: z.string(),
			path: z.string(),
			title: z.string(),
		})
	),
	visibilityRequest: VisibilityRequestSchema.nullable(),
}) satisfies z.ZodType<PersistedModel>;

function initialSpace(scenario: PersistedModel["scenario"]): Space {
	return {
		createdAt: 1_790_000_000_000,
		description: "Disposable Space used by the sidebar interaction proof.",
		documentCount: 0,
		icon: null,
		id: "space-scope-proof",
		name: "Synthetic Space",
		retrievalMode: "vector",
		system: scenario === "system",
		updatedAt: 1_790_000_000_000,
		visibility: scenario === "restricted" ? "team" : "private",
	};
}

function readModel(): PersistedModel {
	const raw = localStorage.getItem(STORAGE_KEY);
	if (raw) {
		try {
			return ModelSchema.parse(JSON.parse(raw));
		} catch {
			// Start from the deterministic synthetic record if a prior run left junk.
		}
	}
	const scenario = new URLSearchParams(location.search).get("scenario");
	const safeScenario: PersistedModel["scenario"] =
		scenario === "restricted" || scenario === "system" ? scenario : "default";
	const space = initialSpace(safeScenario);
	return {
		deleteCalls: 0,
		lastError: "",
		lastPluginAction: "",
		navigationPath: "/chat",
		reloadCount: 0,
		scenario: safeScenario,
		space,
		tabs: [
			{
				icon: null,
				id: "proof-current-tab",
				path: "/chat",
				title: "New chat",
			},
		],
		visibilityRequest: null,
	};
}

function installTauriFixture() {
	const host =
		/* SAFETY: This module owns the optional private fixture holders: installTauriFixture writes the captured-call array and controlled invoke/transformCallback seam; ScopeMenuProof writes getSpace/onFileStored/onReload from its actual model. This preserves Window and does not assert a production Tauri implementation. */ window as Window & {
			__TAURI_INTERNALS__?: {
				invoke?: (...args: unknown[]) => Promise<void>;
				transformCallback?: (...args: unknown[]) => number;
			};
			__SPACE_SCOPE_TAURI_CALLS__?: unknown[][];
		};
	host.__SPACE_SCOPE_TAURI_CALLS__ = [];
	host.__TAURI_INTERNALS__ = {
		invoke: async (...args) => {
			host.__SPACE_SCOPE_TAURI_CALLS__?.push(args);
			return undefined;
		},
		transformCallback: () => 0,
	};
}

function ScopeMenuProof() {
	const [model, setModel] = useState(readModel);
	const modelRef = useRef(model);
	modelRef.current = model;
	const [addOpen, setAddOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [visibilitySaving, setVisibilitySaving] = useState(false);

	const commit = (next: PersistedModel) => {
		modelRef.current = next;
		setModel(next);
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	};

	/* SAFETY: This module owns the optional private fixture holders: installTauriFixture writes the captured-call array and controlled invoke/transformCallback seam; ScopeMenuProof writes getSpace/onFileStored/onReload from its actual model. This preserves Window and does not assert a production Tauri implementation. */ (
		window as Window & {
			__SPACE_SCOPE_MENU_PROOF__?: {
				getSpace: () => Space | null;
				onFileStored: (spaceId: string) => void;
				onReload: () => void;
			};
		}
	).__SPACE_SCOPE_MENU_PROOF__ = {
		getSpace: () => modelRef.current.space,
		onFileStored: (spaceId) => {
			const current = modelRef.current;
			if (current.space?.id === spaceId) {
				commit({
					...current,
					space: {
						...current.space,
						documentCount: current.space.documentCount + 1,
					},
				});
			}
		},
		onReload: () => {
			commit({
				...modelRef.current,
				reloadCount: modelRef.current.reloadCount + 1,
			});
		},
	};

	const openTab = (
		path: string,
		options?: {
			forceNew?: boolean;
			icon?: GlyphValue;
			title?: string;
		}
	) => {
		const current = modelRef.current;
		const nextTab: ProofTab = {
			icon: options?.icon ?? current.space?.icon ?? null,
			id: options?.forceNew
				? `proof-tab-${current.tabs.length + 1}`
				: (current.tabs[0]?.id ?? "proof-current-tab"),
			path,
			title: options?.title ?? path,
		};
		const tabs = options?.forceNew
			? [...current.tabs, nextTab]
			: [nextTab, ...current.tabs.slice(1)];
		commit({ ...current, navigationPath: path, tabs });
		return nextTab.id;
	};

	const tabsContextValue = createTabsProofContext({
		openTab,
		updateTabsIconWhere: (matches: (tab: Tab) => boolean, icon: GlyphValue) => {
			const current = modelRef.current;
			commit({
				...current,
				tabs: current.tabs.map((tab) =>
					matches(tab) ? { ...tab, icon } : tab
				),
			});
		},
	});

	const space = model.space;
	const apiTarget = { token: null, url: window.location.origin };
	const contributedRows: EntityRow[] = [
		{
			icon: null,
			id: "proof:space:open-collection",
			label: "Open fixture collection",
			onSelect: () =>
				commit({
					...modelRef.current,
					lastPluginAction: `space:${space?.id ?? "missing"}:open-collection`,
				}),
		},
	];

	const requestVisibilityChange = (request: VisibilityChangeRequest) =>
		commit({ ...modelRef.current, visibilityRequest: request });

	const confirmVisibilityChange = async () => {
		const request = modelRef.current.visibilityRequest;
		if (!request) {
			return;
		}
		setVisibilitySaving(true);
		try {
			await setSpaceVisibility(
				apiTarget,
				request.id,
				resourceVisibilityForGroup(request.to)
			);
			const current = modelRef.current;
			commit({
				...current,
				space: current.space
					? {
							...current.space,
							visibility: resourceVisibilityForGroup(request.to),
						}
					: null,
				visibilityRequest: null,
			});
		} catch (error) {
			commit({
				...modelRef.current,
				lastError:
					error instanceof Error
						? error.message
						: "Could not update visibility",
			});
		} finally {
			setVisibilitySaving(false);
		}
	};

	const confirmDelete = async (): Promise<boolean> => {
		if (!modelRef.current.space) {
			return false;
		}
		setDeleting(true);
		try {
			await deleteSpace(apiTarget, modelRef.current.space.id);
			commit({
				...modelRef.current,
				deleteCalls: modelRef.current.deleteCalls + 1,
				space: null,
			});
			return true;
		} catch (error) {
			commit({
				...modelRef.current,
				deleteCalls: modelRef.current.deleteCalls + 1,
				lastError:
					error instanceof Error
						? error.message
						: "Could not delete this Space",
			});
			return false;
		} finally {
			setDeleting(false);
		}
	};

	const rows = space ? contributedRows : [];
	const canDelete = Boolean(
		space && !space.system && model.scenario !== "restricted"
	);
	const canMakePrivate = model.scenario !== "restricted";

	return (
		<AppSurfaceProvider surface="desktop">
			<TabsContext.Provider value={tabsContextValue}>
				<main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-5 bg-background p-8 text-foreground">
					<header>
						<p className="text-muted-foreground text-xs uppercase tracking-widest">
							Desktop sidebar · synthetic fixture
						</p>
						<h1 className="mt-1 font-semibold text-2xl">Space scope menu</h1>
					</header>
					<section className="w-80 rounded-xl border border-border bg-sidebar p-3">
						{space ? (
							<SpaceScopeMenu
								canDelete={canDelete}
								canMakePrivate={canMakePrivate}
								contributedRows={rows}
								onAdd={() => setAddOpen(true)}
								onOpen={() =>
									openTab(`/spaces/${space.id}`, {
										icon: space.icon,
										title: space.name,
									})
								}
								onOpenInNewTab={() =>
									openTab(`/spaces/${space.id}`, {
										forceNew: true,
										icon: space.icon,
										title: space.name,
									})
								}
								onOpenInNewWindow={() => {
									void openEntityInNewWindow({
										path: `/spaces/${space.id}`,
										title: space.name,
									});
								}}
								onRename={async (name) => {
									await renameSpace(apiTarget, space.id, name);
									const current = modelRef.current;
									commit({
										...current,
										space: current.space ? { ...current.space, name } : null,
									});
								}}
								onRequestDelete={() => setPendingDelete(true)}
								onRequestVisibilityChange={requestVisibilityChange}
								setSpaceIcon={async (id, icon) => {
									await saveSpaceIcon(apiTarget, id, icon);
									const current = modelRef.current;
									commit({
										...current,
										space: current.space ? { ...current.space, icon } : null,
									});
								}}
								space={space}
							/>
						) : (
							<p data-testid="space-deleted">The synthetic Space is deleted.</p>
						)}
					</section>
					<section className="grid grid-cols-2 gap-x-8 gap-y-2 rounded-xl border border-border p-4 text-sm">
						<span>Space name</span>
						<output data-testid="space-name">{space?.name ?? "deleted"}</output>
						<span>Space visibility</span>
						<output data-testid="space-visibility">
							{space?.visibility ?? "deleted"}
						</output>
						<span>Space icon</span>
						<output data-testid="space-icon">
							{JSON.stringify(space?.icon ?? null)}
						</output>
						<span>Current route</span>
						<output data-testid="navigation-path">
							{model.navigationPath}
						</output>
						<span>Tabs</span>
						<output data-testid="tabs-state">
							{JSON.stringify(model.tabs)}
						</output>
						<span>Space documents</span>
						<output data-testid="document-count">
							{space?.documentCount ?? "deleted"}
						</output>
						<span>Reload calls</span>
						<output data-testid="reload-count">{model.reloadCount}</output>
						<span>Visibility request</span>
						<output data-testid="visibility-request">
							{JSON.stringify(model.visibilityRequest)}
						</output>
						<span>Plugin action</span>
						<output data-testid="plugin-action">
							{model.lastPluginAction}
						</output>
						<span>Last error</span>
						<output data-testid="last-error">{model.lastError}</output>
					</section>
					<output className="sr-only" data-testid="delete-open">
						{String(pendingDelete)}
					</output>
					<AddToSpaceDialog
						onClose={() => setAddOpen(false)}
						open={addOpen}
						spaceId={space?.id ?? null}
					/>
					<ResourceVisibilityConfirmationDialog
						canMakePrivate={canMakePrivate}
						changing={visibilitySaving}
						onConfirm={() => {
							void confirmVisibilityChange();
						}}
						onOpenChange={(open) => {
							if (!open) {
								commit({ ...modelRef.current, visibilityRequest: null });
							}
						}}
						request={model.visibilityRequest}
					/>
					<DestructiveConfirmDialog
						busy={deleting}
						description={`"${space?.name ?? "Synthetic Space"}" and all its documents will be permanently deleted. This can't be undone.`}
						label={`Delete ${space?.name ?? "Synthetic Space"}`}
						onConfirm={confirmDelete}
						onOpenChange={(open) => setPendingDelete(open)}
						open={pendingDelete}
						title="Delete this Space?"
					/>
				</main>
			</TabsContext.Provider>
		</AppSurfaceProvider>
	);
}

installTauriFixture();
const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Space scope proof root element was not found");
}
createRoot(rootElement).render(<ScopeMenuProof />);
