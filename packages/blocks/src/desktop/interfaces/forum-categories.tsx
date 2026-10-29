import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import {
	CATEGORY_SECTION_LABELS,
	categorySections,
	type ForumCategory,
	fullDate,
} from "./forum-model.ts";
import { CategorySwatch, ForumAvatar, TEXT_BUTTON } from "./forum-parts.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";

const HEAD_CELL =
	"h-10 px-2 text-left align-middle font-normal text-muted-foreground text-sm";

function LatestCell({
	category,
	now,
	onOpen,
	snapshot,
}: {
	category: ForumCategory;
	now: number;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const latest = category.latest;
	if (!latest) {
		return <span className="text-muted-foreground text-sm">No topics yet</span>;
	}
	const author =
		latest.lastMessageRole === "user"
			? null
			: (agentById(snapshot, latest.agentIds[0]) ?? null);
	return (
		<div className="flex min-w-0 items-center gap-2.5">
			<ForumAvatar agent={author} size={24} />
			<div className="min-w-0">
				<button
					className={cn(
						TEXT_BUTTON,
						"block max-w-full truncate font-medium text-foreground text-sm leading-5"
					)}
					onClick={() => onOpen(latest.id)}
					type="button"
				>
					{latest.title || "Untitled topic"}
				</button>
				<p className="truncate text-muted-foreground text-xs leading-4">
					{author?.name ?? "You"}
					<span aria-hidden="true"> · </span>
					<time dateTime={latest.updatedAt} title={fullDate(latest.updatedAt)}>
						{compactAge(latest.updatedAt, now)}
					</time>
				</p>
			</div>
		</div>
	);
}

function CategoryRow({
	category,
	now,
	onOpen,
	onSelect,
	snapshot,
}: {
	category: ForumCategory;
	now: number;
	onOpen: (threadId: string) => void;
	onSelect: (categoryId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const working = category.agent?.status === "working";
	return (
		<tr className="border-border border-b" data-category-id={category.id}>
			<td className="py-3.5 pr-2 pl-3 align-top">
				<div className="flex min-w-0 items-start gap-3">
					<CategorySwatch category={category} className="mt-[5px] size-3" />
					<div className="min-w-0">
						<div className="flex min-w-0 items-baseline gap-2">
							<button
								className={cn(
									TEXT_BUTTON,
									"truncate font-semibold text-[15px] text-foreground leading-5"
								)}
								onClick={() => onSelect(category.id)}
								type="button"
							>
								{category.name}
							</button>
							{working ? (
								<span className="shrink-0 text-success text-xs">Working</span>
							) : null}
						</div>
						{category.description ? (
							<p className="mt-0.5 line-clamp-2 text-muted-foreground text-sm leading-5">
								{category.description}
							</p>
						) : null}
					</div>
				</div>
			</td>
			<td className="px-2 py-3.5 text-center align-top text-foreground text-sm tabular-nums leading-5">
				{category.topicIds.length}
			</td>
			<td className="@min-[720px]:table-cell hidden py-3 pr-3 pl-2 align-top">
				<LatestCell
					category={category}
					now={now}
					onOpen={onOpen}
					snapshot={snapshot}
				/>
			</td>
		</tr>
	);
}

/**
 * The categories page, phpBB-style: one table, sectioned into projects,
 * teams, and agents, each row with its colour square, name, description,
 * topic count, and its latest topic.
 */
export function CategoriesTable({
	categories,
	now,
	onOpen,
	onSelect,
	snapshot,
}: {
	categories: readonly ForumCategory[];
	now: number;
	onOpen: (threadId: string) => void;
	onSelect: (categoryId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	return (
		<table
			className="w-full table-fixed border-collapse"
			data-testid="forum-categories"
		>
			<colgroup>
				<col />
				<col className="w-20" />
				<col className="@min-[720px]:table-column hidden w-[38%]" />
			</colgroup>
			<thead>
				<tr className="border-border border-b">
					<th className={cn(HEAD_CELL, "pl-3")} scope="col">
						Category
					</th>
					<th className={cn(HEAD_CELL, "text-center")} scope="col">
						Topics
					</th>
					<th
						className={cn(HEAD_CELL, "@min-[720px]:table-cell hidden pr-3")}
						scope="col"
					>
						Latest
					</th>
				</tr>
			</thead>
			{categorySections(categories).map((section) => (
				<tbody key={section.kind}>
					<tr>
						<th
							className="px-3 pt-6 pb-2 text-left font-medium text-foreground text-xs uppercase tracking-wide"
							colSpan={3}
							scope="colgroup"
						>
							{CATEGORY_SECTION_LABELS[section.kind]}
						</th>
					</tr>
					{section.categories.map((category) => (
						<CategoryRow
							category={category}
							key={category.id}
							now={now}
							onOpen={onOpen}
							onSelect={onSelect}
							snapshot={snapshot}
						/>
					))}
				</tbody>
			))}
		</table>
	);
}
