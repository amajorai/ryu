import { FolderAddIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { type ComponentType, type ReactNode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	loadPageSizes,
	SidebarScopePicker,
	savePageSizes,
	usePickerSelection,
} from "../../src/components/layout/sidebar-scope-picker.tsx";
import {
	SectionActionButton,
	SectionAddButton,
	SidebarSection,
	SubSectionActionButton,
} from "../../src/components/layout/sidebar-section.tsx";
import { SectionPagingControls } from "../../src/components/layout/sidebar-section-overflow.tsx";
import {
	loadSectionOrder,
	type SectionKey,
	saveSectionOrder,
} from "../../src/components/layout/sidebar-sections.ts";
import {
	loadSorts,
	saveSorts,
	usePaged,
} from "../../src/components/layout/sidebar-sort-paging.ts";
import {
	loadHiddenSections,
	persistHiddenSections,
} from "../../src/lib/features.ts";
import "../../src/index.css";
import {
	IDLE_REORDER_SHIFT,
	type ReorderShift,
} from "@ryu/ui/hooks/use-reorder-shift.tsx";

type SortKey = "default" | "updated" | "created" | "name-asc" | "name-desc";

interface PageState<T> {
	canShowLess: boolean;
	hasMore: boolean;
	items: T[];
	lessCount: number;
	remaining: number;
	showLess: () => void;
	showMore: () => void;
	visible: T[];
}

interface ScopeOption {
	label: string;
	value: string;
}

interface OverflowSpec<T> {
	getSearchText: (item: T) => string;
	items: T[];
	label: string;
	renderList: (items: T[]) => ReactNode;
}

interface SectionMenu {
	canMove: (key: SectionKey, direction: "up" | "down") => boolean;
	onHide: (key: SectionKey) => void;
	onMove: (key: SectionKey, direction: "up" | "down") => void;
	onOpenCustomize: () => void;
	onSetPageSize: (key: SectionKey, size: number) => void;
	onSetSort: (key: SectionKey, sort: SortKey) => void;
}

interface SectionDnd {
	draggingKey: SectionKey | null;
	dragOverKey: SectionKey | null;
	onDragEnd: () => void;
	onDragOver: (key: SectionKey) => void;
	onDragStart: (key: SectionKey) => void;
	onDrop: (key: SectionKey) => void;
	order: SectionKey[];
	shift: ReorderShift;
}

interface SidebarSectionProps {
	action?: ReactNode;
	children: ReactNode;
	collapsed: boolean;
	dnd: SectionDnd;
	label: string;
	menu: SectionMenu;
	onToggleCollapsed: (key: SectionKey) => void;
	pageSize: number;
	sectionKey: SectionKey;
	sort: SortKey;
}

export interface AppSidebarProofExports {
	loadPageSizes: () => Partial<Record<SectionKey, number>>;
	loadSorts: () => Partial<Record<SectionKey, SortKey>>;
	SectionActionButton: ComponentType<{
		icon: IconSvgElement;
		onClick: () => void;
		title: string;
	}>;
	SectionAddButton: ComponentType<{ onClick: () => void; title: string }>;
	SectionPagingControls: <T>(props: {
		paged: PageState<T>;
		overflow?: OverflowSpec<T>;
	}) => ReactNode;
	SidebarScopePicker: ComponentType<{
		allLabel: string;
		icon?: IconSvgElement;
		onValueChange: (value: string) => void;
		options: ScopeOption[];
		value: string;
	}>;
	SidebarSection: ComponentType<SidebarSectionProps>;
	SubSectionActionButton: ComponentType<{
		icon: IconSvgElement;
		onClick: () => void;
		title: string;
	}>;
	savePageSizes: (sizes: Partial<Record<SectionKey, number>>) => void;
	saveSorts: (sorts: Partial<Record<SectionKey, SortKey>>) => void;
	usePaged: <T>(items: T[], pageSize: number) => PageState<T>;
	usePickerSelection: (
		storageKey: string,
		options: ScopeOption[]
	) => [string, (value: string) => void];
}

// The production controls under test, imported from the modules that own them.
const controls: AppSidebarProofExports = {
	loadPageSizes,
	loadSorts,
	SectionActionButton,
	SectionAddButton,
	SectionPagingControls,
	SidebarScopePicker,
	SidebarSection,
	SubSectionActionButton,
	savePageSizes,
	saveSorts,
	usePaged,
	usePickerSelection,
};

const PROJECT_SELECTION_KEY = "ryu:sidebar-project-selection";
const PROJECTS: ScopeOption[] = [
	{ label: "Project Alpha", value: "/workspace/alpha" },
	{ label: "Project Beta", value: "/workspace/beta" },
];
const ITEMS = [
	{ id: "alpha", name: "Alpha" },
	{ id: "bravo", name: "Bravo" },
	{ id: "charlie", name: "Charlie" },
	{ id: "delta", name: "Delta" },
	{ id: "echo", name: "Echo" },
	{ id: "foxtrot", name: "Foxtrot" },
];
const SECTION_KEY: SectionKey = "projects";

function ScopeFixture() {
	const [value, setValue] = controls.usePickerSelection(
		PROJECT_SELECTION_KEY,
		PROJECTS
	);
	return (
		<div className="w-72 rounded-lg border border-border/60 bg-sidebar p-2">
			<controls.SidebarScopePicker
				allLabel="All projects"
				icon={FolderAddIcon}
				onValueChange={setValue}
				options={PROJECTS}
				value={value}
			/>
			<output className="sr-only" data-testid="scope-value">
				{value}
			</output>
		</div>
	);
}

function SectionFixture() {
	const [order, setOrder] = useState(() => loadSectionOrder());
	const [hiddenSections, setHiddenSections] = useState(() =>
		loadHiddenSections()
	);
	const [pageSizes, setPageSizes] = useState(() => controls.loadPageSizes());
	const [sorts, setSorts] = useState(() => controls.loadSorts());
	const [collapsed, setCollapsed] = useState(false);
	const [lastAction, setLastAction] = useState<string | null>(null);
	const [selectedItem, setSelectedItem] = useState("");
	const [customizeOpen, setCustomizeOpen] = useState(false);
	const pageSize = pageSizes[SECTION_KEY] ?? 2;
	const sort = sorts[SECTION_KEY] ?? "default";
	const sortedItems = useMemo(() => {
		if (sort === "name-asc") {
			return [...ITEMS].sort((a, b) => a.name.localeCompare(b.name));
		}
		if (sort === "name-desc") {
			return [...ITEMS].sort((a, b) => b.name.localeCompare(a.name));
		}
		return ITEMS;
	}, [sort]);
	const paged = controls.usePaged(sortedItems, pageSize);
	const overflow = useMemo<OverflowSpec<(typeof ITEMS)[number]>>(
		() => ({
			getSearchText: (item) => item.name,
			items: paged.items,
			label: "projects",
			renderList: (items) => (
				<div className="flex flex-col">
					{items.map((item) => (
						<button
							className="rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
							key={item.id}
							onClick={() => {
								setSelectedItem(item.id);
								localStorage.setItem("proof:opened-project", item.id);
							}}
							type="button"
						>
							{item.name}
						</button>
					))}
				</div>
			),
		}),
		[paged.items]
	);
	const menu = useMemo<SectionMenu>(
		() => ({
			canMove: (key, direction) => {
				const index = order.indexOf(key);
				return direction === "up"
					? index > 0
					: index >= 0 && index < order.length - 1;
			},
			onHide: (key) => {
				const next = new Set(hiddenSections);
				next.add(key);
				setHiddenSections(next);
				persistHiddenSections(next);
			},
			onMove: (key, direction) => {
				const index = order.indexOf(key);
				const nextIndex = direction === "up" ? index - 1 : index + 1;
				if (index < 0 || nextIndex < 0 || nextIndex >= order.length) {
					return;
				}
				const next = [...order];
				[next[index], next[nextIndex]] = [next[nextIndex], next[index]];
				setOrder(next);
				saveSectionOrder(next);
			},
			onOpenCustomize: () => {
				setCustomizeOpen(true);
				setLastAction("Customize sidebar");
			},
			onSetPageSize: (key, size) => {
				const next = { ...pageSizes, [key]: size };
				setPageSizes(next);
				controls.savePageSizes(next);
			},
			onSetSort: (key, nextSort) => {
				const next = { ...sorts, [key]: nextSort };
				setSorts(next);
				controls.saveSorts(next);
			},
		}),
		[hiddenSections, order, pageSizes, sorts]
	);
	const dnd = useMemo<SectionDnd>(
		() => ({
			draggingKey: null,
			dragOverKey: null,
			onDragEnd: () => undefined,
			onDragOver: () => undefined,
			onDragStart: () => undefined,
			onDrop: () => undefined,
			shift: IDLE_REORDER_SHIFT,
			order,
		}),
		[order]
	);
	const action = (
		<controls.SectionAddButton
			onClick={() => setLastAction("Create project")}
			title="Create project"
		/>
	);

	return (
		<div className="space-y-2">
			{hiddenSections.has(SECTION_KEY) ? (
				<p
					className="rounded-lg border border-border/60 bg-sidebar p-4 text-muted-foreground text-sm"
					data-testid="section-hidden"
				>
					Projects section hidden
				</p>
			) : (
				<controls.SidebarSection
					action={action}
					collapsed={collapsed}
					dnd={dnd}
					label="Projects"
					menu={menu}
					onToggleCollapsed={() => setCollapsed((current) => !current)}
					pageSize={pageSize}
					sectionKey={SECTION_KEY}
					sort={sort}
				>
					<div className="space-y-3 px-2 pb-3" data-testid="projects-content">
						<div data-testid="visible-items">
							{paged.visible.map((item) => (
								<div key={item.id}>{item.name}</div>
							))}
						</div>
						<controls.SectionPagingControls overflow={overflow} paged={paged} />
						<div
							className="group/subsection flex items-center justify-between rounded border border-border/40 px-2 py-1"
							data-testid="subsection-header"
							onClick={() => setCollapsed((current) => !current)}
						>
							<span>Workspace folders</span>
							<controls.SubSectionActionButton
								icon={FolderAddIcon}
								onClick={() => setLastAction("Add folder")}
								title="Add folder"
							/>
						</div>
						<ScopeFixture />
						<div className="type-caption rounded-md border border-border/40 px-2 py-2 text-muted-foreground">
							<p>
								Showing {paged.visible.length} of {paged.items.length} projects
								· {pageSize || "All"} per page
							</p>
							<p>
								Section position {order.indexOf(SECTION_KEY) + 1} of{" "}
								{order.length} ·{" "}
								{hiddenSections.has(SECTION_KEY) ? "hidden" : "shown"}
							</p>
							<p>Last opened: {selectedItem || "none"}</p>
							<p>Last action: {lastAction || "none"}</p>
							<p>
								Customize request: {customizeOpen ? "opened" : "not opened"}
							</p>
						</div>
					</div>
				</controls.SidebarSection>
			)}
			<output className="sr-only" data-testid="section-order">
				{JSON.stringify(order)}
			</output>
			<output className="sr-only" data-testid="hidden-sections">
				{JSON.stringify([...hiddenSections])}
			</output>
			<output className="sr-only" data-testid="page-size">
				{pageSize}
			</output>
			<output className="sr-only" data-testid="sort-value">
				{sort}
			</output>
			<output className="sr-only" data-testid="selected-item">
				{selectedItem}
			</output>
			<output className="sr-only" data-testid="last-action">
				{lastAction}
			</output>
			<output className="sr-only" data-testid="customize-open">
				{String(customizeOpen)}
			</output>
		</div>
	);
}

function Story() {
	return (
		<main className="flex min-h-screen justify-center bg-background px-4 py-8 text-foreground">
			<div
				className="h-fit w-80 rounded-xl border border-border/60 bg-sidebar p-3 text-sidebar-foreground"
				data-testid="projects-section"
			>
				<h1 className="mb-2 px-2 font-semibold text-sm">Sidebar controls</h1>
				<SectionFixture />
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
