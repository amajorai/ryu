import { Package01Icon } from "@hugeicons/core-free-icons";
import { libraryViewDefinition } from "@ryu/app-host/views";
import {
	LibraryCard,
	LibraryEmpty,
	LibraryGrid,
} from "@ryu/blocks/desktop/library.tsx";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { lazy, Suspense } from "react";
import { pluginSidebarSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
import {
	BoardRenderer,
	CalendarRenderer,
	FeedRenderer,
	GalleryRenderer,
	type LibraryViewProps,
	ListRenderer,
	TableRenderer,
	TimelineRenderer,
} from "./LibraryView-renderers.tsx";

// MapLibre is heavy; only load it when a section actually uses the map layout.
const LibraryMapRenderer = lazy(() => import("./LibraryMapRenderer.tsx"));

function renderEmptyOrStatus({
	error,
	isLoading,
	section,
	tl,
}: Pick<LibraryViewProps, "error" | "isLoading" | "section"> & {
	tl: LiteralMessage;
}) {
	if (isLoading) {
		return (
			<div
				aria-busy="true"
				className="p-8 text-center text-muted-foreground text-sm"
			>
				{tl("Loading {title}…", { title: section.title })}
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
								className="size-4 shrink-0"
								icon={section.icon}
								size={16}
								tone="muted"
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

function Placeholder() {
	return (
		<LibraryEmpty
			description="This view is owned by the companion app."
			icon={Package01Icon}
			title="Open in companion"
		/>
	);
}

function MapRenderer({
	rows,
	onOpen,
	section,
}: Pick<LibraryViewProps, "rows" | "onOpen" | "section">) {
	const tl = useLiteralMessages();
	return (
		<Suspense
			fallback={
				<div
					aria-busy="true"
					className="p-8 text-center text-muted-foreground text-sm"
				>
					{tl("Loading {title} map…", { title: section.title })}
				</div>
			}
		>
			<LibraryMapRenderer onOpen={onOpen} rows={rows} />
		</Suspense>
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
	const tl = useLiteralMessages();
	const definition = libraryViewDefinition(pluginSidebarSpec(section)?.view);
	const status = renderEmptyOrStatus({ error, isLoading, section, tl });
	if (status) {
		return status;
	}
	const renderer = definition?.renderer;
	if (renderer === "custom") {
		return <Placeholder />;
	}
	if (rows.length === 0) {
		return (
			<LibraryEmpty
				description={tl("{title} has nothing in it yet.", {
					title: section.title,
				})}
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
			return <MapRenderer onOpen={onOpen} rows={rows} section={section} />;
		case "custom":
			return <Placeholder />;
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
