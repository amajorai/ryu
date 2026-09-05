import { Package01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	libraryViewDefinition,
	type SourceItem,
	type ViewItem,
} from "@ryu/app-host/views";
import {
	LibraryCard,
	LibraryEmpty,
	LibraryGrid,
} from "@ryu/blocks/desktop/library";
import type { ViewMode } from "@ryu/blocks/desktop/view-toggle";
import { Icon } from "@ryu/ui/components/icon";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import type { PluginSidebarSection } from "@/src/lib/api/plugins.ts";

interface LibraryViewProps {
	error: Error | null;
	isLoading: boolean;
	onOpen: (row: SourceItem) => void;
	rows: SourceItem[];
	section: PluginSidebarSection;
	view: ViewMode;
}

function RowButton({
	children,
	onClick,
	className,
}: {
	children: ReactNode;
	className?: string;
	onClick: () => void;
}) {
	return (
		<button
			className={cn(
				"w-full rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
				className
			)}
			onClick={onClick}
			type="button"
		>
			{children}
		</button>
	);
}

function RowCopy({ item }: { item: ViewItem }) {
	return (
		<div className="min-w-0">
			<div className="truncate font-medium text-sm">{item.title}</div>
			{item.subtitle ? (
				<div className="truncate text-muted-foreground text-xs">
					{item.subtitle}
				</div>
			) : null}
		</div>
	);
}

function renderEmptyOrStatus({
	error,
	isLoading,
	section,
}: Pick<LibraryViewProps, "error" | "isLoading" | "section">) {
	if (isLoading) {
		return (
			<div
				aria-busy="true"
				className="p-8 text-center text-muted-foreground text-sm"
			>
				Loading {section.title}…
			</div>
		);
	}
	if (error) {
		return (
			<LibraryEmpty
				description="This collection could not be loaded."
				icon={Package01Icon}
				title="Unable to load"
			/>
		);
	}
	return null;
}

function ListRenderer({
	rows,
	onOpen,
}: Pick<LibraryViewProps, "rows" | "onOpen">) {
	return (
		<div aria-label="Library items" className="flex flex-col gap-1" role="list">
			{rows.map((row) => (
				<RowButton
					className="flex items-center gap-3 border border-border/60 bg-card px-3 py-3 hover:bg-accent"
					key={row.item.id}
					onClick={() => onOpen(row)}
				>
					{row.item.avatar ? (
						<img
							alt=""
							className="size-9 rounded-md object-cover"
							src={row.item.avatar}
						/>
					) : (
						<Icon
							className="size-4 shrink-0 text-muted-foreground"
							icon="package-01"
							size={16}
						/>
					)}
					<RowCopy item={row.item} />
					{row.item.accessory ? (
						<span className="ml-auto shrink-0 text-muted-foreground text-xs">
							{row.item.accessory}
						</span>
					) : null}
				</RowButton>
			))}
		</div>
	);
}

function TableRenderer({
	rows,
	onOpen,
}: Pick<LibraryViewProps, "rows" | "onOpen">) {
	return (
		<div className="overflow-x-auto rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Name</TableHead>
						<TableHead>Details</TableHead>
						<TableHead>Metadata</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.item.id} onClick={() => onOpen(row)}>
							<TableCell className="font-medium">{row.item.title}</TableCell>
							<TableCell>
								{row.item.subtitle ?? row.item.detail ?? "—"}
							</TableCell>
							<TableCell>{row.item.accessory ?? "—"}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function BoardRenderer({
	rows,
	onOpen,
}: Pick<LibraryViewProps, "rows" | "onOpen">) {
	const groups = new Map<string, SourceItem[]>();
	for (const row of rows) {
		const group = row.item.badges?.[0]?.label ?? row.item.accessory ?? "Other";
		groups.set(group, [...(groups.get(group) ?? []), row]);
	}
	return (
		<div
			aria-label="Library board"
			className="grid gap-3 md:grid-cols-3"
			role="list"
		>
			{[...groups].map(([group, groupRows]) => (
				<section className="min-w-0 rounded-lg bg-muted/40 p-3" key={group}>
					<h3 className="mb-2 font-medium text-sm">{group}</h3>
					<div className="flex flex-col gap-2">
						{groupRows.map((row) => (
							<RowButton
								className="bg-card p-3 shadow-sm"
								key={row.item.id}
								onClick={() => onOpen(row)}
							>
								<RowCopy item={row.item} />
							</RowButton>
						))}
					</div>
				</section>
			))}
		</div>
	);
}

function CalendarRenderer({
	rows,
	onOpen,
}: Pick<LibraryViewProps, "rows" | "onOpen">) {
	const groups = new Map<string, SourceItem[]>();
	for (const row of rows) {
		const rawDate =
			row.raw.date ??
			row.raw.startDate ??
			row.raw.createdAt ??
			row.raw.updatedAt;
		const date = rawDate ? new Date(String(rawDate)) : null;
		const label =
			date && !Number.isNaN(date.valueOf())
				? date.toLocaleDateString(undefined, { dateStyle: "medium" })
				: "Undated";
		groups.set(label, [...(groups.get(label) ?? []), row]);
	}
	return (
		<div
			aria-label="Library calendar"
			className="grid gap-3 md:grid-cols-2"
			role="list"
		>
			{[...groups].map(([date, dateRows]) => (
				<section className="rounded-lg border p-3" key={date}>
					<h3 className="mb-2 font-medium text-sm">{date}</h3>
					<div className="flex flex-col gap-2">
						{dateRows.map((row) => (
							<RowButton
								className="p-2 hover:bg-accent"
								key={row.item.id}
								onClick={() => onOpen(row)}
							>
								<RowCopy item={row.item} />
							</RowButton>
						))}
					</div>
				</section>
			))}
		</div>
	);
}

function TimelineRenderer({
	rows,
	onOpen,
}: Pick<LibraryViewProps, "rows" | "onOpen">) {
	return (
		<div
			aria-label="Library timeline"
			className="relative ml-3 border-l pl-5"
			role="list"
		>
			{rows.map((row) => (
				<RowButton
					className="relative mb-4 p-2 hover:bg-accent"
					key={row.item.id}
					onClick={() => onOpen(row)}
				>
					<span
						aria-hidden="true"
						className="absolute top-4 -left-[1.65rem] size-2 rounded-full bg-primary"
					/>
					<RowCopy item={row.item} />
				</RowButton>
			))}
		</div>
	);
}

function FeedRenderer({
	rows,
	onOpen,
}: Pick<LibraryViewProps, "rows" | "onOpen">) {
	return (
		<div
			aria-label="Library feed"
			className="flex flex-col divide-y rounded-lg border"
			role="list"
		>
			{rows.map((row) => (
				<RowButton
					className="flex gap-3 p-3 hover:bg-accent"
					key={row.item.id}
					onClick={() => onOpen(row)}
				>
					{row.item.avatar ? (
						<img
							alt=""
							className="size-10 rounded-full object-cover"
							src={row.item.avatar}
						/>
					) : (
						<HugeiconsIcon
							aria-hidden="true"
							className="mt-1 size-4 text-muted-foreground"
							icon={Package01Icon}
						/>
					)}
					<div className="min-w-0 flex-1">
						<RowCopy item={row.item} />
						{row.item.detail ? (
							<p className="mt-1 text-muted-foreground text-xs">
								{row.item.detail}
							</p>
						) : null}
					</div>
					{row.item.accessory ? (
						<span className="text-muted-foreground text-xs">
							{row.item.accessory}
						</span>
					) : null}
				</RowButton>
			))}
		</div>
	);
}

function GalleryRenderer({
	rows,
	onOpen,
}: Pick<LibraryViewProps, "rows" | "onOpen">) {
	return (
		<div
			aria-label="Library gallery"
			className="grid grid-cols-2 gap-3 md:grid-cols-3"
			role="list"
		>
			{rows.map((row) => (
				<RowButton
					className="overflow-hidden border bg-card hover:bg-accent"
					key={row.item.id}
					onClick={() => onOpen(row)}
				>
					{row.item.avatar ? (
						<img
							alt=""
							className="aspect-[4/3] w-full object-cover"
							src={row.item.avatar}
						/>
					) : (
						<div className="flex aspect-[4/3] items-center justify-center bg-muted">
							<Icon
								className="size-6 text-muted-foreground"
								icon="package-01"
								size={24}
							/>
						</div>
					)}
					<div className="p-3">
						<RowCopy item={row.item} />
					</div>
				</RowButton>
			))}
		</div>
	);
}

function CardRenderer({
	rows,
	onOpen,
	view,
	section,
}: Pick<LibraryViewProps, "rows" | "onOpen" | "view" | "section">) {
	return (
		<LibraryGrid columns={2} view={view}>
			{rows.map((row) => (
				<LibraryCard
					item={{
						key: row.item.id,
						icon: Package01Icon,
						iconNode: section.icon ? (
							<Icon
								className="size-4 shrink-0 opacity-70"
								icon={section.icon}
								size={16}
							/>
						) : undefined,
						name: row.item.title,
						subtitle: row.item.subtitle ?? null,
						badge: row.item.accessory ?? null,
						favorited: false,
					}}
					key={row.item.id}
					onOpen={() => onOpen(row)}
					view={view}
				/>
			))}
		</LibraryGrid>
	);
}

function Placeholder({ kind }: { kind: "map" | "custom" }) {
	return (
		<LibraryEmpty
			description={
				kind === "custom"
					? "This view is owned by the companion app."
					: "Map views are not available in this host yet."
			}
			icon={Package01Icon}
			title={kind === "custom" ? "Open in companion" : "Map view unavailable"}
		/>
	);
}

export default function LibraryView({
	error,
	isLoading,
	onOpen,
	rows,
	section,
	view,
}: LibraryViewProps) {
	const definition = libraryViewDefinition(section.spec?.view);
	const status = renderEmptyOrStatus({ error, isLoading, section });
	if (status) {
		return status;
	}
	const renderer = definition?.renderer;
	if (renderer === "map" || renderer === "custom") {
		return <Placeholder kind={renderer} />;
	}
	if (rows.length === 0) {
		return (
			<LibraryEmpty
				description={`${section.title} has nothing in it yet.`}
				icon={Package01Icon}
				title="Nothing yet"
			/>
		);
	}
	if (!definition) {
		return (
			<CardRenderer onOpen={onOpen} rows={rows} section={section} view={view} />
		);
	}
	switch (definition.renderer) {
		case "board":
			return <BoardRenderer onOpen={onOpen} rows={rows} />;
		case "calendar":
			return <CalendarRenderer onOpen={onOpen} rows={rows} />;
		case "feed":
			return <FeedRenderer onOpen={onOpen} rows={rows} />;
		case "gallery":
			return <GalleryRenderer onOpen={onOpen} rows={rows} />;
		case "list":
			return <ListRenderer onOpen={onOpen} rows={rows} />;
		case "table":
			return <TableRenderer onOpen={onOpen} rows={rows} />;
		case "timeline":
			return <TimelineRenderer onOpen={onOpen} rows={rows} />;
		case "map":
			return <Placeholder kind="map" />;
		case "custom":
			return <Placeholder kind="custom" />;
		default:
			return (
				<CardRenderer
					onOpen={onOpen}
					rows={rows}
					section={section}
					view={view}
				/>
			);
	}
}
