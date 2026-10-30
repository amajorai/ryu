import {
	Archive02Icon,
	CloudDownloadIcon,
	File01Icon,
	Link01Icon,
	Table01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorLine } from "@/src/components/agents/shared/error-line.tsx";
import {
	useComposioActions,
	useComposioConnections,
	useComposioStatus,
	useComposioToolkits,
} from "@/src/hooks/useComposioCatalog.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createSpaceComposioImport,
	createSpaceFileImport,
	fetchSpaceImports,
	type SpaceImportRecord,
	type SpaceImportResultDocument,
} from "@/src/lib/api/space-imports.ts";
import { ComposioImportForm } from "./space-imports/composio-form.tsx";
import { FileImportCard } from "./space-imports/fields.tsx";
import { ImportHistorySection } from "./space-imports/history.tsx";
import {
	ARCHIVE_ACCEPT,
	buildArguments,
	DATABASE_ACCEPT,
	DOCUMENT_ACCEPT,
	errorMessage,
} from "./space-imports/model.ts";

interface SpaceImportsPanelProps {
	onImportCompleted: () => void;
	onManageConnections: () => void;
	onOpenDocument: (document: SpaceImportResultDocument) => void;
	spaceId: string;
	target: ApiTarget;
}

export function SpaceImportsPanel({
	onImportCompleted,
	onManageConnections,
	onOpenDocument,
	spaceId,
	target,
}: SpaceImportsPanelProps) {
	const [imports, setImports] = useState<SpaceImportRecord[]>([]);
	const [historyError, setHistoryError] = useState<string | null>(null);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const [toolkit, setToolkit] = useState("");
	const [actionName, setActionName] = useState("");
	const [destinationKind, setDestinationKind] = useState<
		"auto" | "page" | "database"
	>("auto");
	const [importTitle, setImportTitle] = useState("");
	const [argumentValues, setArgumentValues] = useState<Record<string, string>>(
		{}
	);
	const [composioError, setComposioError] = useState<string | null>(null);
	const [composioBusy, setComposioBusy] = useState(false);
	const seenCompleted = useRef(new Set<string>());

	const status = useComposioStatus();
	const configured = status.data?.configured ?? false;
	const connections = useComposioConnections("", configured);
	const toolkits = useComposioToolkits(configured);
	const connectedToolkits = useMemo(
		() =>
			new Set(
				(connections.data ?? [])
					.filter((item) => item.active)
					.map((item) => item.toolkit.toLowerCase())
			),
		[connections.data]
	);
	const availableToolkits = useMemo(
		() =>
			(toolkits.data ?? []).filter((item) =>
				connectedToolkits.has(item.slug.toLowerCase())
			),
		[connectedToolkits, toolkits.data]
	);
	const actions = useComposioActions(toolkit || null, "", ["readOnlyHint"]);
	const readActions = useMemo(
		() =>
			(actions.data ?? []).filter((item) =>
				item.tags.some((tag) => tag.toLowerCase() === "readonlyhint")
			),
		[actions.data]
	);
	const selectedAction =
		readActions.find((item) => item.name === actionName) ?? null;
	const hasActiveImport = imports.some(
		(item) => item.status === "pending" || item.status === "running"
	);

	const loadHistory = useCallback(async () => {
		try {
			const next = await fetchSpaceImports(target, spaceId);
			setImports(next);
			let completedNow = false;
			for (const item of next) {
				if (
					item.status === "completed" &&
					!seenCompleted.current.has(item.id)
				) {
					seenCompleted.current.add(item.id);
					completedNow = true;
				}
			}
			if (completedNow) {
				onImportCompleted();
			}
			setHistoryError(null);
		} catch (error) {
			setHistoryError(errorMessage(error));
		}
	}, [onImportCompleted, spaceId, target]);

	useEffect(() => {
		loadHistory().catch(() => undefined);
	}, [loadHistory]);

	useEffect(() => {
		if (!hasActiveImport) {
			return;
		}
		const timer = window.setInterval(() => {
			loadHistory().catch(() => undefined);
		}, 1500);
		return () => window.clearInterval(timer);
	}, [hasActiveImport, loadHistory]);

	useEffect(() => {
		if (toolkit && availableToolkits.some((item) => item.slug === toolkit)) {
			return;
		}
		setToolkit(availableToolkits[0]?.slug ?? "");
	}, [availableToolkits, toolkit]);

	useEffect(() => {
		if (actionName && readActions.some((item) => item.name === actionName)) {
			return;
		}
		setActionName(readActions[0]?.name ?? "");
		setArgumentValues({});
	}, [actionName, readActions]);

	const importFiles = async (files: FileList) => {
		setUploading(true);
		setUploadError(null);
		try {
			for (const file of Array.from(files)) {
				const created = await createSpaceFileImport(target, spaceId, file);
				setImports((current) => [
					created,
					...current.filter((item) => item.id !== created.id),
				]);
			}
		} catch (error) {
			setUploadError(errorMessage(error));
		} finally {
			setUploading(false);
		}
	};

	const startComposioImport = async () => {
		if (!(selectedAction && toolkit)) {
			return;
		}
		setComposioBusy(true);
		setComposioError(null);
		try {
			const created = await createSpaceComposioImport(target, spaceId, {
				toolkit,
				action: selectedAction.name,
				arguments: buildArguments(selectedAction, argumentValues),
				destinationKind,
				title: importTitle.trim() || undefined,
			});
			setImports((current) => [
				created,
				...current.filter((item) => item.id !== created.id),
			]);
		} catch (error) {
			setComposioError(errorMessage(error));
		} finally {
			setComposioBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-8 p-4">
			<header>
				<h2 className="font-medium text-lg">Import</h2>
				<p className="mt-1 text-muted-foreground text-sm">
					Turn files and connected-app data into editable pages and databases in
					this space.
				</p>
			</header>

			<section className="flex flex-col gap-3">
				<div>
					<h3 className="font-medium text-sm">File-based imports</h3>
					<p className="mt-1 text-muted-foreground text-xs">
						Select several files at once, or use a ZIP to import a folder.
					</p>
				</div>
				<div className="grid gap-3 md:grid-cols-3">
					<FileImportCard
						accept={DOCUMENT_ACCEPT}
						description="Text, Markdown, HTML, Word, PDF, EPUB, and OPML become pages."
						disabled={uploading}
						icon={<HugeiconsIcon className="size-5" icon={File01Icon} />}
						id="space-import-documents"
						onFiles={(files) => importFiles(files).catch(() => undefined)}
						title="Documents"
					/>
					<FileImportCard
						accept={DATABASE_ACCEPT}
						description="CSV, TSV, DSV, Excel, and OpenDocument sheets become databases."
						disabled={uploading}
						icon={<HugeiconsIcon className="size-5" icon={Table01Icon} />}
						id="space-import-databases"
						onFiles={(files) => importFiles(files).catch(() => undefined)}
						title="Spreadsheets"
					/>
					<FileImportCard
						accept={ARCHIVE_ACCEPT}
						description="ZIP folders can mix every supported page and database format."
						disabled={uploading}
						icon={<HugeiconsIcon className="size-5" icon={Archive02Icon} />}
						id="space-import-archives"
						onFiles={(files) => importFiles(files).catch(() => undefined)}
						title="ZIP archive"
					/>
				</div>
				{uploading ? (
					<p className="flex items-center gap-2 text-muted-foreground text-sm">
						<Spinner className="size-3" /> Uploading files…
					</p>
				) : null}
				{uploadError ? <ErrorLine message={uploadError} /> : null}
			</section>

			<section className="flex flex-col gap-3">
				<div>
					<h3 className="font-medium text-sm">Third-party imports</h3>
					<p className="mt-1 text-muted-foreground text-xs">
						Read data from a connected app with Composio. Only read-only actions
						are available.
					</p>
				</div>
				<Card>
					<CardHeader>
						<CardTitle layout="badge-row" variant="section">
							<HugeiconsIcon className="size-4" icon={CloudDownloadIcon} />
							Import from a connected app
						</CardTitle>
						<CardDescription>
							Choose a connected toolkit, its read action, and where the result
							should go.
						</CardDescription>
					</CardHeader>
					<CardContent layout="spaced-stack">
						{configured ? (
							availableToolkits.length === 0 ? (
								<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
									<span>
										Connect an app to make its import actions available here.
									</span>
									<Button
										onClick={onManageConnections}
										size="sm"
										variant="outline"
									>
										Manage connections
									</Button>
								</div>
							) : (
								<ComposioImportForm
									actionName={actionName}
									argumentValues={argumentValues}
									availableToolkits={availableToolkits}
									composioBusy={composioBusy}
									composioError={composioError}
									destinationKind={destinationKind}
									importTitle={importTitle}
									onImport={() => startComposioImport().catch(() => undefined)}
									readActions={readActions}
									selectedAction={selectedAction}
									setActionName={setActionName}
									setArgumentValues={setArgumentValues}
									setDestinationKind={setDestinationKind}
									setImportTitle={setImportTitle}
									setToolkit={setToolkit}
									toolkit={toolkit}
								/>
							)
						) : (
							<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
								<span>Configure Composio in Connections before importing.</span>
								<Button
									onClick={onManageConnections}
									size="sm"
									variant="outline"
								>
									<HugeiconsIcon className="size-4" icon={Link01Icon} /> Manage
									connections
								</Button>
							</div>
						)}
					</CardContent>
				</Card>
			</section>

			<ImportHistorySection
				historyError={historyError}
				imports={imports}
				onOpenDocument={onOpenDocument}
				onRefresh={() => loadHistory().catch(() => undefined)}
			/>
		</div>
	);
}
