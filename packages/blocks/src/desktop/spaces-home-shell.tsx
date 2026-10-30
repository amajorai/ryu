"use client";

import {
	Add01Icon,
	ArrowDown01Icon,
	FolderOpenIcon,
	Home01Icon,
	LibraryIcon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input";
import type { ChangeEvent, ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import { isMarkdownPage } from "./spaces-document-format.ts";
import {
	RecentDocumentRow,
	SpaceTemplateCard,
} from "./spaces-document-rows.tsx";
import { FilesTableSection } from "./spaces-files-table.tsx";
import type { SpaceDocumentRow, SpaceRow } from "./spaces-types.ts";

type SpaceHomeTab = "recent" | "pinned" | "shared";

function greetingLabel(): string {
	const hour = new Date().getHours();
	if (hour < 12) {
		return "Good morning";
	}
	if (hour < 18) {
		return "Good afternoon";
	}
	return "Good evening";
}

function SpaceHomeRail({
	onHome,
	onNewPage,
	onOpenFiles,
	spaceName,
}: {
	onHome: () => void;
	onNewPage?: () => void;
	onOpenFiles: () => void;
	spaceName: string;
}) {
	return (
		<aside
			aria-label="Space navigation"
			className="hidden w-[94px] shrink-0 flex-col border-border/80 border-r bg-space-rail py-3 text-space-rail-foreground sm:flex dark:bg-space-rail-dark dark:text-space-rail-foreground-dark"
			data-testid="spaces-home-rail"
		>
			<div className="flex flex-col gap-2 px-2">
				<button
					aria-current="page"
					className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-md border-2 border-space-navigation-active bg-white text-space-navigation-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-space-navigation-surface-dark dark:text-space-navigation-foreground-dark"
					onClick={onHome}
					type="button"
				>
					<HugeiconsIcon className="size-5" icon={Home01Icon} />
					<span className="type-caption">Home</span>
				</button>
				<button
					className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-md border border-transparent outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/5"
					onClick={onNewPage}
					type="button"
				>
					<HugeiconsIcon className="size-5" icon={Add01Icon} />
					<span className="type-caption">New</span>
				</button>
				<button
					className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-md border border-transparent outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/5"
					onClick={onOpenFiles}
					type="button"
				>
					<HugeiconsIcon className="size-5" icon={FolderOpenIcon} />
					<span className="type-caption">Open</span>
				</button>
			</div>
			<div className="mt-auto flex flex-col gap-3 border-border/70 border-t px-2 pt-3">
				<div className="flex flex-col items-center gap-1 text-center">
					<div className="flex size-7 items-center justify-center rounded-md bg-space-rail-icon text-muted-foreground dark:bg-space-rail-icon-dark">
						<HugeiconsIcon className="size-4" icon={LibraryIcon} />
					</div>
					<span className="type-compact max-w-16 truncate">{spaceName}</span>
				</div>
			</div>
		</aside>
	);
}

export function SpaceHomeShell({
	children,
	documents,
	documentsError,
	onNewDatabase,
	onNewPage,
	onNewWhiteboard,
	onOpenDoc,
	space,
	uploadPanel,
}: {
	children: ReactNode;
	documents: SpaceDocumentRow[];
	documentsError?: string | null;
	onNewDatabase?: () => void;
	onNewPage?: () => void;
	onNewWhiteboard?: () => void;
	onOpenDoc?: (docId: string, title: string) => void;
	space: SpaceRow;
	uploadPanel?: ReactNode;
}) {
	const tl = useLiteralMessages();
	const [activeTab, setActiveTab] = useState<SpaceHomeTab>("recent");
	const [query, setQuery] = useState("");
	const homeScrollRef = useRef<HTMLDivElement>(null);
	const filesAnchorRef = useRef<HTMLDivElement>(null);
	const recentDocuments = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		return [...documents]
			.filter(isMarkdownPage)
			.filter((document) => {
				if (!normalized) {
					return true;
				}
				return `${document.title} ${space.name}`
					.toLowerCase()
					.includes(normalized);
			})
			.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
			.slice(0, 5);
	}, [documents, query, space.name]);

	const scrollHome = () => {
		homeScrollRef.current?.scrollTo({ top: 0 });
	};
	const scrollToFiles = () => {
		filesAnchorRef.current?.scrollIntoView({ block: "start" });
	};

	return (
		<div
			className="flex min-h-full bg-space-home text-space-home-foreground dark:bg-space-home-dark dark:text-space-home-foreground-dark"
			data-testid="spaces-home"
		>
			<SpaceHomeRail
				onHome={scrollHome}
				onNewPage={onNewPage}
				onOpenFiles={scrollToFiles}
				spaceName={space.name}
			/>
			<div
				className="scroll-fade min-w-0 flex-1 overflow-auto"
				ref={homeScrollRef}
			>
				<div className="mx-auto max-w-[1120px] px-5 py-6 sm:px-8 sm:py-8">
					<header
						className="border-border/70 border-b pb-5"
						data-testid="spaces-hero"
					>
						<div className="flex flex-wrap items-start justify-between gap-4">
							<div>
								<p className="text-muted-foreground text-sm">{space.name}</p>
								<h1 className="mt-1 font-heading font-semibold text-2xl tracking-space-greeting sm:text-3xl">
									{greetingLabel()}
								</h1>
							</div>
						</div>
						{space.description ? (
							<p className="mt-3 max-w-2xl text-muted-foreground text-sm leading-relaxed">
								{space.description}
							</p>
						) : null}
					</header>

					<section aria-labelledby="new-documents-title" className="pt-6">
						<h2
							className="flex items-center gap-1 font-semibold text-sm"
							id="new-documents-title"
						>
							<HugeiconsIcon className="size-3.5" icon={ArrowDown01Icon} />
							New
						</h2>
						<div className="mt-3 flex gap-3 overflow-x-auto pb-2">
							<SpaceTemplateCard
								featured
								kind="blank"
								label="Blank document"
								onClick={onNewPage}
							/>
							<SpaceTemplateCard
								kind="welcome"
								label="Welcome to Space"
								onClick={onNewPage}
							/>
							<SpaceTemplateCard
								kind="table"
								label="First table"
								onClick={onNewDatabase}
							/>
							<SpaceTemplateCard
								kind="simple"
								label="Single spaced"
								onClick={onNewPage}
							/>
							<SpaceTemplateCard
								kind="board"
								label="Blank board"
								onClick={onNewWhiteboard}
							/>
							<div className="flex shrink-0 items-center px-2 text-primary text-xs">
								More templates <span className="ml-1 text-base">→</span>
							</div>
						</div>
					</section>

					<section
						aria-labelledby="recent-documents-title"
						className="pt-5"
						data-testid="spaces-recent-pages"
					>
						<div className="relative max-w-[430px]">
							<HugeiconsIcon
								aria-hidden="true"
								className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
								icon={Search01Icon}
							/>
							<Input
								aria-label="Search documents"
								className="h-10"
								leadingAdornment="default"
								onChange={(event: ChangeEvent<HTMLInputElement>) =>
									setQuery(event.target.value)
								}
								placeholder="Search"
								value={query}
								variant="document-search"
							/>
						</div>
						<div className="mt-6">
							<h2
								className="font-heading font-semibold text-xl"
								id="recent-documents-title"
							>
								Recent
							</h2>
						</div>
						<div
							aria-label="Document views"
							className="mt-3 flex items-center gap-5 border-border/70 border-b"
							role="tablist"
						>
							{(
								[
									["recent", "Recent"],
									["pinned", "Pinned"],
									["shared", "Shared with Me"],
								] as const
							).map(([value, label]) => (
								<button
									aria-selected={activeTab === value}
									className={`border-b-2 px-0.5 py-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${activeTab === value ? "border-space-navigation-active font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
									onClick={() => setActiveTab(value)}
									role="tab"
									type="button"
								>
									{label}
								</button>
							))}
						</div>
						<div
							className="mt-2 overflow-hidden rounded-md border bg-card"
							data-testid="spaces-recent-list"
						>
							{activeTab === "recent" && recentDocuments.length > 0 ? (
								recentDocuments.map((document) => (
									<RecentDocumentRow
										document={document}
										key={document.id}
										onOpenDoc={onOpenDoc}
										spaceName={space.name}
									/>
								))
							) : (
								<div className="px-4 py-9 text-center text-muted-foreground text-sm">
									{activeTab === "pinned"
										? "No pinned pages yet."
										: activeTab === "shared"
											? "No pages have been shared with you yet."
											: query
												? tl("No recent pages match “{query}”.", { query })
												: "No recent pages yet."}
								</div>
							)}
						</div>
					</section>

					{uploadPanel ? <div className="mt-6">{uploadPanel}</div> : null}

					<div className="mt-10 scroll-mt-4" ref={filesAnchorRef}>
						<FilesTableSection
							documents={documents}
							documentsError={documentsError}
							onOpenDoc={onOpenDoc}
							onQueryChange={setQuery}
							query={query}
						/>
					</div>

					<div className="mt-10 flex flex-col gap-6">{children}</div>
				</div>
			</div>
		</div>
	);
}
