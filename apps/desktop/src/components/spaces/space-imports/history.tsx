import {
	ArrowUpRight01Icon,
	DatabaseIcon,
	File01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import type {
	SpaceImportRecord,
	SpaceImportResultDocument,
} from "@/src/lib/api/space-imports.ts";
import {
	formatBytes,
	formatWhen,
	importSourceLabel,
	openResultLabel,
	statusVariant,
} from "./model.ts";

/** Earlier imports into this space, newest first, with links to their results. */
export function ImportHistorySection({
	historyError,
	imports,
	onOpenDocument,
	onRefresh,
}: {
	historyError: string | null;
	imports: SpaceImportRecord[];
	onOpenDocument: (document: SpaceImportResultDocument) => void;
	onRefresh: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<section className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-3">
				<div>
					<h3 className="font-medium text-sm">Previous imports</h3>
					<p className="mt-1 text-muted-foreground text-xs">
						Newest imports appear first.
					</p>
				</div>
				<Button onClick={onRefresh} size="sm" variant="ghost">
					Refresh
				</Button>
			</div>
			{historyError ? <ErrorLine message={historyError} /> : null}
			{imports.length === 0 && !historyError ? (
				<p className="py-6 text-center text-detail text-muted-foreground">
					No imports yet.
				</p>
			) : (
				<ul aria-live="polite" className="flex flex-col">
					{imports.map((item) => (
						<li
							className="border-border border-b py-3 last:border-b-0"
							key={item.id}
						>
							<div className="flex flex-wrap items-start justify-between gap-3">
								<div className="min-w-0">
									<div className="flex items-center gap-2">
										<HugeiconsIcon
											className="size-4 shrink-0 text-muted-foreground"
											icon={
												item.destinationKind === "database"
													? DatabaseIcon
													: File01Icon
											}
										/>
										<p
											className="truncate font-medium text-sm"
											title={item.sourceName}
										>
											{item.sourceName}
										</p>
										<Badge variant={statusVariant(item.status)}>
											{item.status}
										</Badge>
									</div>
									<p className="mt-1 text-muted-foreground text-xs">
										{importSourceLabel(item)}
										{" · "}
										{formatWhen(item.createdAt)}
										{item.byteSize > 0
											? ` · ${formatBytes(item.byteSize)}`
											: ""}
										{item.status === "completed"
											? ` · ${tl(
													"{count, plural, one {{countLabel} item} other {{countLabel} items}}",
													{
														count: item.itemCount,
														countLabel: String(item.itemCount),
													}
												)}`
											: ""}
									</p>
									{item.message ? (
										<p
											className={
												item.status === "failed"
													? "mt-2 text-status-destructive text-xs"
													: "mt-2 text-muted-foreground text-xs"
											}
										>
											{item.message}
										</p>
									) : null}
								</div>
								{item.status === "pending" || item.status === "running" ? (
									<Spinner className="mt-1 size-4" />
								) : item.resultDocuments.length ? (
									<div className="flex flex-wrap gap-2">
										{item.resultDocuments.map((document) => (
											<Button
												key={document.id}
												onClick={() => onOpenDocument(document)}
												size="sm"
												variant="ghost"
											>
												{openResultLabel(document.title)}
												<HugeiconsIcon
													className="size-4"
													icon={ArrowUpRight01Icon}
												/>
											</Button>
										))}
									</div>
								) : null}
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
