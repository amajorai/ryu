import { Package01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SourceItem, ViewItem } from "@ryu/app-host/views";
import type { ViewMode } from "@ryu/blocks/desktop/view-toggle.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table.tsx";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import type { PluginSidebarSection } from "@/src/lib/api/plugins.ts";
import { formatDate } from "@/src/lib/timezone.ts";

export interface LibraryViewProps {
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
			<div className="truncate font-medium text-sm" title={item.title}>
				{item.title}
			</div>
			{item.subtitle ? (
				<div
					className="truncate text-muted-foreground text-xs"
					title={item.subtitle}
				>
					{item.subtitle}
				</div>
			) : null}
		</div>
	);
}

export function ListRenderer({
	rows,
	onOpen,
}: Pick<LibraryViewProps, "rows" | "onOpen">) {
	return (
		<div aria-label="Library items" className="flex flex-col" role="list">
			{rows.map((row) => (
				<RowButton
					className="flex min-h-12 items-center gap-3 rounded-none border-border border-b px-2 py-2 last:border-b-0 hover:bg-muted"
					key={row.item.id}
					onClick={() => onOpen(row)}
				>
					{row.item.avatar ? (
						<img
							alt=""
							className="size-8 rounded-lg object-cover"
							src={safeMediaUrl(row.item.avatar) ?? undefined}
						/>
					) : (
						<Icon
							className="size-4 shrink-0"
							icon="package-01"
							size={16}
							tone="muted"
						/>
					)}
					<RowCopy item={row.item} />
					{row.item.accessory ? (
						<span className="ml-auto shrink-0 text-muted-foreground/70 text-xs">
							{row.item.accessory}
						</span>
					) : null}
				</RowButton>
			))}
		</div>
	);
}

export function TableRenderer({
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
							<TableCell presentation="row-header">
								<button
									className="rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
									onClick={(event) => {
										event.stopPropagation();
										onOpen(row);
									}}
									type="button"
								>
									{row.item.title}
								</button>
							</TableCell>
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

export function BoardRenderer({
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
								className="rounded-lg bg-background p-3"
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

export function CalendarRenderer({
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
				? formatDate(date, { dateStyle: "medium" })
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

export function TimelineRenderer({
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

export function FeedRenderer({
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
							src={safeMediaUrl(row.item.avatar) ?? undefined}
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

export function GalleryRenderer({
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
							src={safeMediaUrl(row.item.avatar) ?? undefined}
						/>
					) : (
						<div className="flex aspect-[4/3] items-center justify-center bg-muted">
							<Icon
								className="size-5"
								icon="package-01"
								size={20}
								tone="muted"
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
