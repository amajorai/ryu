// apps/desktop/src/components/store/WorkflowTemplatesSection.tsx
//
// The Workflow Templates section in the Store. Browses Core's workflow-template
// catalog (`GET /api/workflows/catalog`): ready-made workflows keyed by the
// agent-design PATTERN each demonstrates (evaluator-optimizer, routing,
// orchestrator-workers, the autoresearch git-ledger loop, …). Installing a card
// mints a brand-new workflow (Core assigns fresh ids and patches any durable
// `while` bodies) and returns its id; on success we toast and open the new
// workflow's canvas in a tab.
//
// Uses the shared App-Store catalog layout (StoreCatalogLayout: a card grid with
// a floating preview) like Apps, Plugins, Models, MCP, Skills, and Agents.
// Templates are grouped by category into section headers in the list
// (Research · Orchestration · Quality · Automation), mirroring the App Store's
// "Featured"/"Productivity" rows.

import {
	Alert01Icon,
	CheckmarkCircle02Icon,
	Download01Icon,
	Link01Icon,
	WorkflowSquare01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import StoreItemAction from "@ryu/marketplace/catalog/chrome/store-item-action";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { useMemo, useState } from "react";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useDebouncedValue } from "@/src/hooks/use-debounced-value.ts";
import { useWorkflowTemplatesCatalog } from "@/src/hooks/useWorkflowTemplatesCatalog.ts";
import type {
	WorkflowTemplateCategory,
	WorkflowTemplateMeta,
} from "@/src/lib/api/workflows.ts";

const SEARCH_DEBOUNCE_MS = 200;

/** Display order + labels for the category section headers. */
const CATEGORY_ORDER: {
	label: string;
	value: WorkflowTemplateCategory;
}[] = [
	{ value: "research", label: "Research" },
	{ value: "orchestration", label: "Orchestration" },
	{ value: "quality", label: "Quality" },
	{ value: "automation", label: "Automation" },
];

/** "evaluator-optimizer" → "Evaluator Optimizer". */
function humanizePattern(pattern: string): string {
	return pattern
		.split("-")
		.map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
		.join(" ");
}

function TemplateBadges({ template }: { template: WorkflowTemplateMeta }) {
	return (
		<>
			<Badge variant="secondary">{humanizePattern(template.pattern)}</Badge>
			<Badge variant="outline">
				<HugeiconsIcon className="size-3" icon={WorkflowSquare01Icon} />
				{template.nodeCount} {template.nodeCount === 1 ? "node" : "nodes"}
			</Badge>
			{template.tags.slice(0, 3).map((tag) => (
				<Badge key={tag} variant="outline">
					{tag}
				</Badge>
			))}
		</>
	);
}

function TemplateInstallButton({
	installed,
	busy,
	onInstall,
}: {
	installed: boolean;
	busy: boolean;
	onInstall: () => void;
}) {
	if (installed) {
		return (
			<Badge variant="secondary">
				<HugeiconsIcon className="size-3" icon={CheckmarkCircle02Icon} />
				Added
			</Badge>
		);
	}
	return (
		<InstallProgressButton
			idleVariant="ghost"
			installing={busy}
			onClick={onInstall}
		>
			<HugeiconsIcon className="size-4" icon={Download01Icon} />
			Install
		</InstallProgressButton>
	);
}

/** Card action: an Install button until installed, then a non-interactive
 *  "Added" pill. "Added" is ephemeral (this-session installs only) and there is
 *  no uninstall/enable concept, so we don't route through StoreItemAction's
 *  installed morph — that would surface an Uninstall/Enable affordance we can't
 *  honour. */
function WorkflowCardAction({
	installed,
	busy,
	onInstall,
}: {
	installed: boolean;
	busy: boolean;
	onInstall: () => void;
}) {
	if (installed) {
		return (
			<Button disabled size="sm" variant="secondary">
				Added
			</Button>
		);
	}
	return (
		<StoreItemAction busy={busy} installed={false} onInstall={onInstall} />
	);
}

function TemplateList({
	groups,
	loading,
	error,
	selectedId,
	installedIds,
	pendingId,
	onSelect,
	onInstall,
}: {
	groups: {
		label: string;
		value: WorkflowTemplateCategory;
		items: WorkflowTemplateMeta[];
	}[];
	loading: boolean;
	error: string | null;
	selectedId: string | null;
	installedIds: Set<string>;
	pendingId: string | null;
	onSelect: (id: string) => void;
	onInstall: (template: WorkflowTemplateMeta) => void;
}) {
	const total = groups.reduce((n, g) => n + g.items.length, 0);

	if (loading && total === 0) {
		return (
			<div className="flex items-center justify-center p-8 text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error && total === 0) {
		return (
			<div className="p-4 text-destructive text-sm">
				Couldn't load workflow templates: {error}
			</div>
		);
	}
	if (total === 0) {
		return (
			<Empty className="h-full p-6">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={WorkflowSquare01Icon} />
					</EmptyMedia>
					<EmptyTitle>No templates found</EmptyTitle>
					<EmptyDescription>Try a different search.</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div>
			{groups.map((group) => (
				<section className="mb-6" key={group.value}>
					<h3 className="mb-2 px-1 font-medium text-muted-foreground text-xs uppercase tracking-widest">
						{group.label}
					</h3>
					<StoreCardGrid>
						{group.items.map((template) => (
							<StoreCatalogCard
								action={
									<WorkflowCardAction
										busy={pendingId === template.id}
										installed={installedIds.has(template.id)}
										onInstall={() => onInstall(template)}
									/>
								}
								description={template.description}
								icon={
									<HugeiconsIcon
										className="size-5"
										icon={WorkflowSquare01Icon}
									/>
								}
								key={template.id}
								name={template.name}
								onClick={() => onSelect(template.id)}
								selected={template.id === selectedId}
							/>
						))}
					</StoreCardGrid>
				</section>
			))}
		</div>
	);
}

function TemplateDetailPanel({
	template,
	busy,
	installed,
	error,
	onInstall,
}: {
	template: WorkflowTemplateMeta | null;
	busy: boolean;
	installed: boolean;
	error: string | null;
	onInstall: () => void;
}) {
	if (!template) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={WorkflowSquare01Icon} />
					</EmptyMedia>
					<EmptyTitle>No template selected</EmptyTitle>
					<EmptyDescription>
						Pick a workflow template on the left to review it before installing.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div className="scroll-fade-effect-y flex h-full flex-col gap-6 overflow-auto p-4">
			<header className="flex flex-col gap-3">
				<div className="flex items-start justify-between gap-3">
					<div className="flex min-w-0 items-center gap-3">
						<HugeiconsIcon
							className="size-8 shrink-0 text-muted-foreground"
							icon={WorkflowSquare01Icon}
						/>
						<h2 className="truncate font-semibold text-xl">{template.name}</h2>
					</div>
					<TemplateInstallButton
						busy={busy}
						installed={installed}
						onInstall={onInstall}
					/>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<TemplateBadges template={template} />
				</div>
				<p className="text-muted-foreground text-sm">
					{template.description || "No description provided."}
				</p>
				{template.sourceUrl && (
					<a
						className="flex w-fit items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
						href={template.sourceUrl}
						rel="noopener noreferrer"
						target="_blank"
					>
						<HugeiconsIcon className="size-4" icon={Link01Icon} />
						Source
					</a>
				)}
				{error && (
					<p className="flex items-center gap-1.5 text-destructive text-sm">
						<HugeiconsIcon className="size-4 shrink-0" icon={Alert01Icon} />
						{error}
					</p>
				)}
			</header>
		</div>
	);
}

export default function WorkflowTemplatesSection({
	initialQuery = "",
}: {
	initialQuery?: string;
} = {}) {
	const [query, setQuery] = useState(initialQuery);
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const { templates, loading, error, install, pendingId } =
		useWorkflowTemplatesCatalog();
	const { openTab } = useTabsContext();
	const [errorId, setErrorId] = useState<string | null>(null);
	const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());

	const grouped = useMemo(() => {
		const q = debouncedQuery.trim().toLowerCase();
		return CATEGORY_ORDER.map((cat) => ({
			...cat,
			items: templates
				.filter((t) => t.category === cat.value)
				.filter(
					(t) =>
						!q ||
						t.name.toLowerCase().includes(q) ||
						(t.description?.toLowerCase().includes(q) ?? false) ||
						t.pattern.toLowerCase().includes(q) ||
						t.tags.some((tag) => tag.toLowerCase().includes(q))
				)
				.sort((a, b) => a.name.localeCompare(b.name)),
		})).filter((g) => g.items.length > 0);
	}, [templates, debouncedQuery]);

	const selectedTemplate = useMemo(() => {
		for (const group of grouped) {
			const found = group.items.find((t) => t.id === selectedId);
			if (found) {
				return found;
			}
		}
		return null;
	}, [grouped, selectedId]);

	const handleInstall = async (template: WorkflowTemplateMeta) => {
		setErrorId(null);
		try {
			const workflowId = await install(template.id);
			setInstalledIds((prev) => new Set(prev).add(template.id));
			toast.success("Workflow created", {
				description: `${template.name} is ready to run.`,
			});
			openTab(`/workflows/${workflowId}`, { title: template.name });
		} catch {
			setErrorId(template.id);
		}
	};

	return (
		<StoreCatalogLayout
			detail={
				<TemplateDetailPanel
					busy={pendingId === selectedId}
					error={errorId === selectedId ? error : null}
					installed={selectedId !== null && installedIds.has(selectedId)}
					onInstall={() => {
						if (selectedTemplate) {
							handleInstall(selectedTemplate);
						}
					}}
					template={selectedTemplate}
				/>
			}
			detailTitle={selectedTemplate?.name ?? "Workflow template"}
			hasSelection={selectedTemplate != null}
			list={
				<TemplateList
					error={error}
					groups={grouped}
					installedIds={installedIds}
					loading={loading}
					onInstall={handleInstall}
					onSelect={setSelectedId}
					pendingId={pendingId}
					selectedId={selectedId}
				/>
			}
			onCloseDetail={() => setSelectedId(null)}
			search={{
				value: query,
				onChange: setQuery,
				placeholder: "Search workflow templates…",
			}}
		/>
	);
}
