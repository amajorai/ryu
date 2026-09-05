import {
	Archive02Icon,
	ArrowUpRight01Icon,
	CloudDownloadIcon,
	DatabaseIcon,
	File01Icon,
	Link01Icon,
	Table01Icon,
	Upload01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { Textarea } from "@ryu/ui/components/textarea";
import {
	type ChangeEvent,
	type ComponentProps,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	useComposioActions,
	useComposioConnections,
	useComposioStatus,
	useComposioToolkits,
} from "@/src/hooks/useComposioCatalog.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	ComposioAction,
	ComposioInputProperty,
} from "@/src/lib/api/composio.ts";
import {
	createSpaceComposioImport,
	createSpaceFileImport,
	fetchSpaceImports,
	type SpaceImportRecord,
	type SpaceImportResultDocument,
} from "@/src/lib/api/space-imports.ts";

const DOCUMENT_ACCEPT =
	".txt,.text,.md,.markdown,.mdown,.mkdn,.mkd,.rmd,.html,.htm,.docx,.pdf,.epub,.opml";
const DATABASE_ACCEPT = ".csv,.tsv,.dsv,.xlsx,.xls,.ods";
const ARCHIVE_ACCEPT = ".zip";

interface SpaceImportsPanelProps {
	onImportCompleted: () => void;
	onManageConnections: () => void;
	onOpenDocument: (document: SpaceImportResultDocument) => void;
	spaceId: string;
	target: ApiTarget;
}

function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: "The import could not be started.";
}

function openResultLabel(title: string): string {
	return /^open\b/i.test(title.trim()) ? title : `Open ${title}`;
}

function formatBytes(bytes: number): string {
	if (bytes <= 0) {
		return "";
	}
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(timestamp));
}

function statusVariant(
	status: SpaceImportRecord["status"]
): ComponentProps<typeof Badge>["variant"] {
	if (status === "completed") {
		return "secondary";
	}
	if (status === "failed") {
		return "destructive";
	}
	return "outline";
}

function FileImportCard({
	accept,
	description,
	disabled,
	icon,
	id,
	onFiles,
	title,
}: {
	accept: string;
	description: string;
	disabled: boolean;
	icon: ReactNode;
	id: string;
	onFiles: (files: FileList) => void;
	title: string;
}) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<Card className="h-full">
			<CardHeader className="gap-3">
				<div className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
					{icon}
				</div>
				<div>
					<CardTitle className="text-sm">{title}</CardTitle>
					<CardDescription className="mt-1">{description}</CardDescription>
				</div>
			</CardHeader>
			<CardContent>
				<input
					accept={accept}
					aria-label={`${title} files`}
					className="sr-only"
					id={id}
					multiple
					onChange={(event: ChangeEvent<HTMLInputElement>) => {
						if (event.target.files?.length) {
							onFiles(event.target.files);
						}
						event.target.value = "";
					}}
					ref={input}
					type="file"
				/>
				<Button
					disabled={disabled}
					onClick={() => input.current?.click()}
					size="sm"
					type="button"
					variant="outline"
				>
					<HugeiconsIcon className="size-4" icon={Upload01Icon} />
					Choose files
				</Button>
			</CardContent>
		</Card>
	);
}

function ArgumentField({
	name,
	onChange,
	property,
	required,
	value,
}: {
	name: string;
	onChange: (value: string) => void;
	property: ComposioInputProperty;
	required: boolean;
	value: string;
}) {
	const label = property.title ?? name.replaceAll("_", " ");
	const type = Array.isArray(property.type) ? property.type[0] : property.type;
	if (property.enum?.length) {
		return (
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`composio-${name}`}>{label}</Label>
				<Select onValueChange={onChange} value={value}>
					<SelectTrigger id={`composio-${name}`}>
						<SelectValue placeholder={`Choose ${label}`} />
					</SelectTrigger>
					<SelectContent>
						{property.enum.map((option) => (
							<SelectItem key={String(option)} value={String(option)}>
								{String(option)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{property.description ? (
					<p className="text-muted-foreground text-xs">
						{property.description}
					</p>
				) : null}
			</div>
		);
	}
	if (type === "boolean") {
		return (
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`composio-${name}`}>{label}</Label>
				<Select onValueChange={onChange} value={value}>
					<SelectTrigger id={`composio-${name}`}>
						<SelectValue placeholder={`Choose ${label}`} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="true">True</SelectItem>
						<SelectItem value="false">False</SelectItem>
					</SelectContent>
				</Select>
				{property.description ? (
					<p className="text-muted-foreground text-xs">
						{property.description}
					</p>
				) : null}
			</div>
		);
	}
	if (type === "object" || type === "array") {
		return (
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`composio-${name}`}>{label}</Label>
				<Textarea
					id={`composio-${name}`}
					onChange={(event) => onChange(event.target.value)}
					placeholder={type === "array" ? "[]" : "{}"}
					required={required}
					rows={3}
					value={value}
				/>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={`composio-${name}`}>{label}</Label>
			<Input
				id={`composio-${name}`}
				onChange={(event) => onChange(event.target.value)}
				placeholder={property.description}
				required={required}
				type={type === "number" || type === "integer" ? "number" : "text"}
				value={value}
			/>
		</div>
	);
}

function defaultArgumentValue(property: ComposioInputProperty): string {
	if (property.default === undefined || property.default === null) {
		return "";
	}
	if (typeof property.default === "object") {
		return JSON.stringify(property.default);
	}
	return String(property.default);
}

function buildArguments(
	action: ComposioAction,
	values: Record<string, string>
) {
	const argumentsValue: Record<string, unknown> = {};
	const required = new Set(action.inputSchema.required ?? []);
	for (const [name, property] of Object.entries(
		action.inputSchema.properties ?? {}
	)) {
		const value = (values[name] ?? defaultArgumentValue(property)).trim();
		if (!value) {
			if (required.has(name)) {
				throw new Error(
					`Enter ${property.title ?? name.replaceAll("_", " ")}.`
				);
			}
			continue;
		}
		const type = Array.isArray(property.type)
			? property.type[0]
			: property.type;
		if (type === "number" || type === "integer") {
			const number = Number(value);
			if (!Number.isFinite(number)) {
				throw new Error(`${property.title ?? name} must be a number.`);
			}
			argumentsValue[name] = number;
		} else if (type === "boolean") {
			argumentsValue[name] = value === "true";
		} else if (type === "array" || type === "object") {
			argumentsValue[name] = JSON.parse(value) as unknown;
		} else {
			argumentsValue[name] = value;
		}
	}
	return argumentsValue;
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
				{uploadError ? (
					<p className="text-destructive text-sm">{uploadError}</p>
				) : null}
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
						<CardTitle className="flex items-center gap-2 text-sm">
							<HugeiconsIcon className="size-4" icon={CloudDownloadIcon} />
							Import from a connected app
						</CardTitle>
						<CardDescription>
							Choose a connected toolkit, its read action, and where the result
							should go.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						{configured ? (
							availableToolkits.length === 0 ? (
								<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
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
								<>
									<div className="grid gap-3 md:grid-cols-2">
										<div className="flex flex-col gap-1.5">
											<Label htmlFor="space-import-toolkit">
												Connected app
											</Label>
											<Select onValueChange={setToolkit} value={toolkit}>
												<SelectTrigger id="space-import-toolkit">
													<SelectValue placeholder="Choose an app">
														{(value) =>
															availableToolkits.find(
																(item) => item.slug === value
															)?.name ?? value
														}
													</SelectValue>
												</SelectTrigger>
												<SelectContent>
													{availableToolkits.map((item) => (
														<SelectItem key={item.slug} value={item.slug}>
															{item.name}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
										<div className="flex flex-col gap-1.5">
											<Label htmlFor="space-import-action">Read action</Label>
											<Select onValueChange={setActionName} value={actionName}>
												<SelectTrigger id="space-import-action">
													<SelectValue placeholder="Choose data to import">
														{(value) =>
															readActions.find((item) => item.name === value)
																?.displayName ?? value
														}
													</SelectValue>
												</SelectTrigger>
												<SelectContent>
													{readActions.map((item) => (
														<SelectItem key={item.name} value={item.name}>
															{item.displayName}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
									</div>
									{selectedAction?.description ? (
										<p className="text-muted-foreground text-xs">
											{selectedAction.description}
										</p>
									) : null}
									<div className="grid gap-3 md:grid-cols-2">
										{Object.entries(
											selectedAction?.inputSchema.properties ?? {}
										).map(([name, property]) => (
											<ArgumentField
												key={name}
												name={name}
												onChange={(value) =>
													setArgumentValues((current) => ({
														...current,
														[name]: value,
													}))
												}
												property={property}
												required={
													selectedAction?.inputSchema.required?.includes(
														name
													) ?? false
												}
												value={
													argumentValues[name] ?? defaultArgumentValue(property)
												}
											/>
										))}
										<div className="flex flex-col gap-1.5">
											<Label htmlFor="space-import-title">Title</Label>
											<Input
												id="space-import-title"
												onChange={(event) => setImportTitle(event.target.value)}
												placeholder={
													selectedAction?.displayName ?? "Imported data"
												}
												value={importTitle}
											/>
										</div>
										<div className="flex flex-col gap-1.5">
											<Label htmlFor="space-import-destination">
												Destination
											</Label>
											<Select
												onValueChange={(value) =>
													setDestinationKind(
														value as "auto" | "page" | "database"
													)
												}
												value={destinationKind}
											>
												<SelectTrigger id="space-import-destination">
													<SelectValue>
														{(value) => {
															if (value === "page") {
																return "Page";
															}
															if (value === "database") {
																return "Database";
															}
															return "Choose from result";
														}}
													</SelectValue>
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="auto">
														Choose from result
													</SelectItem>
													<SelectItem value="page">Page</SelectItem>
													<SelectItem value="database">Database</SelectItem>
												</SelectContent>
											</Select>
										</div>
									</div>
									{composioError ? (
										<p className="text-destructive text-sm">{composioError}</p>
									) : null}
									<Button
										disabled={!selectedAction}
										loading={composioBusy}
										onClick={() => startComposioImport().catch(() => undefined)}
										size="sm"
										type="button"
									>
										{composioBusy ? null : (
											<HugeiconsIcon
												className="size-4"
												icon={CloudDownloadIcon}
											/>
										)}
										Import from{" "}
										{availableToolkits.find((item) => item.slug === toolkit)
											?.name ?? "app"}
									</Button>
								</>
							)
						) : (
							<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
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

			<section className="flex flex-col gap-3">
				<div className="flex items-center justify-between gap-3">
					<div>
						<h3 className="font-medium text-sm">Previous imports</h3>
						<p className="mt-1 text-muted-foreground text-xs">
							Newest imports appear first.
						</p>
					</div>
					<Button
						onClick={() => loadHistory().catch(() => undefined)}
						size="sm"
						variant="ghost"
					>
						Refresh
					</Button>
				</div>
				{historyError ? (
					<p className="text-destructive text-sm">{historyError}</p>
				) : null}
				{imports.length === 0 && !historyError ? (
					<div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
						No imports yet.
					</div>
				) : (
					<ul aria-live="polite" className="flex flex-col gap-2">
						{imports.map((item) => (
							<li className="rounded-lg border p-3" key={item.id}>
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
											<p className="truncate font-medium text-sm">
												{item.sourceName}
											</p>
											<Badge variant={statusVariant(item.status)}>
												{item.status}
											</Badge>
										</div>
										<p className="mt-1 text-muted-foreground text-xs">
											{item.sourceType === "composio"
												? `Composio · ${item.sourceFormat}`
												: item.sourceFormat.toUpperCase()}
											{" · "}
											{formatWhen(item.createdAt)}
											{item.byteSize > 0
												? ` · ${formatBytes(item.byteSize)}`
												: ""}
											{item.status === "completed"
												? ` · ${item.itemCount} item${item.itemCount === 1 ? "" : "s"}`
												: ""}
										</p>
										{item.message ? (
											<p
												className={
													item.status === "failed"
														? "mt-2 text-destructive text-xs"
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
		</div>
	);
}
