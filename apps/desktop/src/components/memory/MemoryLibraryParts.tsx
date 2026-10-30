import {
	Analytics01Icon,
	Delete01Icon,
	MoreHorizontalIcon,
	NeuralNetworkIcon,
	PencilEdit01Icon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import {
	MEMORY_CATEGORIES,
	MEMORY_SCOPES,
	type Memory,
	type MemoryCategory,
	type MemoryScope,
	memoryCategoryLabels,
	memoryScopeLabels,
} from "@/src/lib/api/memory.ts";

// The Memory section's view switcher, its filter sentinel and option builders, and
// one memory row. Shared by `MemoryLibrary` and its filters.

export const ALL = "all";
export type MemoryView = "library" | "graph" | "dream" | "reflect";

const MEMORY_VIEWS: {
	icon: IconSvgElement | null;
	label: string;
	value: MemoryView;
}[] = [
	{ icon: null, label: "Library", value: "library" },
	{ icon: NeuralNetworkIcon, label: "Graph", value: "graph" },
	{ icon: SparklesIcon, label: "Dream", value: "dream" },
	{ icon: Analytics01Icon, label: "Reflect", value: "reflect" },
];

/** The Memory views as a quiet tab row: the active view is a muted wash. */
export function MemoryViewNav({
	onChange,
	value,
}: {
	onChange: (value: MemoryView) => void;
	value: MemoryView;
}) {
	return (
		<div aria-label="Memory views" className="flex gap-1" role="tablist">
			{MEMORY_VIEWS.map((item) => {
				const active = value === item.value;
				return (
					<button
						aria-selected={active}
						className={cn(
							"flex h-8 items-center gap-2 rounded-lg px-3 text-sm transition-colors duration-(--duration-fast) hover:duration-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							active
								? "bg-muted text-foreground"
								: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
						)}
						key={item.value}
						onClick={() => onChange(item.value)}
						role="tab"
						type="button"
					>
						{item.icon ? (
							<HugeiconsIcon className="size-4" icon={item.icon} />
						) : null}
						{item.label}
					</button>
				);
			})}
		</div>
	);
}

// A Select's closed trigger takes its text from `items`, so the sentinel row has
// to be in here too — otherwise the filter reads "all"/"preference" once picked.
//
// Built per render rather than once at module scope: the labels now depend on the
// app-wide "Friendly names" toggle, and a module-level constant would freeze
// whichever vocabulary was active when this file was first imported — leaving the
// closed trigger reading "Node" under a list that says "This device".
export const scopeFilterItems = (labels: Record<MemoryScope, string>) => [
	{ label: "All scopes", value: ALL },
	...MEMORY_SCOPES.map((s) => ({ label: labels[s], value: s })),
];
export const categoryFilterItems = (labels: Record<MemoryCategory, string>) => [
	{ label: "All categories", value: ALL },
	...MEMORY_CATEGORIES.map((c) => ({ label: labels[c], value: c })),
];

/** A single memory row: the content, one muted meta line, at most one
 *  Sensitive badge, and a hover `⋯` with Edit and Delete. */
export function MemoryRow({
	memory,
	onDelete,
	onEdit,
}: {
	memory: Memory;
	onDelete: (memory: Memory) => void;
	onEdit: (memory: Memory) => void;
}) {
	// Both vocabularies come from the one shared table; which one shows is the
	// app-wide "Friendly names" toggle.
	const tl = useLiteralMessages();
	const [friendly] = useFriendlyMode();
	const scopeLabels = memoryScopeLabels(friendly);
	const categoryLabels = memoryCategoryLabels(friendly);
	const meta = [
		scopeLabels[memory.scope],
		categoryLabels[memory.category],
		tl("Importance {importance}", { importance: memory.importance }),
		...memory.tags.map((tag) => `#${tag}`),
	].join(" · ");
	return (
		<li className="group/mem flex items-start gap-3 border-border border-b py-3 last:border-b-0">
			<div className="min-w-0 flex-1">
				<p className="whitespace-pre-wrap text-foreground text-sm">
					{memory.content}
				</p>
				{memory.whenToUse ? (
					<p className="mt-1 text-detail text-muted-foreground">
						{tl("When to use: {whenToUse}", { whenToUse: memory.whenToUse })}
					</p>
				) : null}
				<p className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
					<span>{meta}</span>
					{memory.sensitiveTopics.length > 0 ? (
						<Badge tint="amber" variant="secondary">
							Sensitive topic
						</Badge>
					) : null}
				</p>
			</div>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label="Memory actions"
							className="shrink-0 opacity-0 transition-opacity duration-(--duration-fast) focus-visible:opacity-100 group-hover/mem:opacity-100 group-hover/mem:duration-0 data-[popup-open]:opacity-100"
							size="icon-sm"
							variant="ghost-muted"
						>
							<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
						</Button>
					}
				/>
				<DropdownMenuContent align="end" className="min-w-40">
					<DropdownMenuItem onClick={() => onEdit(memory)}>
						<HugeiconsIcon className="size-4" icon={PencilEdit01Icon} />
						Edit memory
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onClick={() => onDelete(memory)}
						variant="destructive"
					>
						<HugeiconsIcon className="size-4" icon={Delete01Icon} />
						Delete memory
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</li>
	);
}
