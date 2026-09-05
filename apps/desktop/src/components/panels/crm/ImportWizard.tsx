// The CSV import wizard — upload, map, dry-run, apply.
//
// This is in v1 rather than deferred because an empty CRM is unusable, and the
// import is the step every CRM defers and every user needs on day one.
//
// The dry run is the point of the whole flow. Nothing is written until Apply, and
// the preview says exactly how many rows would be created, updated and skipped,
// which rows conflict with an existing value, and which columns nobody mapped —
// so "import 4,000 contacts" stops being an act of faith. The counts are exact for
// the whole file even when the per-row sample list is truncated.
//
// The raw CSV lives on the SERVER with the job, so preview and apply are two
// requests over the same bytes rather than two uploads. That is also why an
// abandoned job still holds the file, and why the app declares it as retained data.

import { Alert01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Label } from "@ryu/ui/components/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ryu/ui/components/table";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { useCallback, useState } from "react";
import type {
	CrmClient,
	ImportJob,
	ImportMapping,
	ImportPreview,
	ImportResult,
	ObjectWithFields,
} from "@/src/lib/api/crm.ts";

type Step = "apply" | "map" | "preview" | "upload";

/** `null` field_id means "do not import this column" — an explicit decision the
 *  server stores, distinct from a column nobody has looked at. */
const SKIP = "__skip__";

export function ImportWizard({
	client,
	onDone,
	subject,
}: {
	client: CrmClient;
	/** Called after a successful apply so the caller can refetch its counts. */
	onDone: () => void;
	subject: ObjectWithFields;
}) {
	const [step, setStep] = useState<Step>("upload");
	const [job, setJob] = useState<ImportJob | null>(null);
	const [mappings, setMappings] = useState<ImportMapping[]>([]);
	const [dedupeFieldId, setDedupeFieldId] = useState<string>("");
	const [preview, setPreview] = useState<ImportPreview | null>(null);
	const [result, setResult] = useState<ImportResult | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const mappableFields = subject.fields.filter(
		(field) => !field.is_system && field.field_type !== "relation"
	);

	const fail = (cause: unknown) =>
		setError(cause instanceof Error ? cause.message : String(cause));

	const onFile = useCallback(
		async (file: File) => {
			setBusy(true);
			setError(null);
			try {
				const text = await file.text();
				const created = await client.createImport(
					subject.object.slug,
					text,
					file.name
				);
				setJob(created);
				// Seed the mapping from the server's own per-column type guess, so a
				// tidy file needs no mapping work at all — the user confirms rather
				// than assigns.
				setMappings(
					created.columns.map((column) => ({
						column_index: column.index,
						field_id: column.suggested_field_id ?? null,
					}))
				);
				setStep("map");
			} catch (cause) {
				fail(cause);
			} finally {
				setBusy(false);
			}
		},
		[client, subject.object.slug]
	);

	const runPreview = async () => {
		if (!job) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await client.setImportMapping(job.id, {
				dedupe: dedupeFieldId
					? { match_field_ids: [dedupeFieldId], strategy: "update" }
					: undefined,
				mappings,
			});
			setPreview(await client.previewImport(job.id));
			setStep("preview");
		} catch (cause) {
			fail(cause);
		} finally {
			setBusy(false);
		}
	};

	const runApply = async () => {
		if (!job) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			setResult(await client.applyImport(job.id));
			setStep("apply");
			onDone();
		} catch (cause) {
			fail(cause);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="border-b px-4 py-3">
				<h2 className="font-medium text-base">
					Import {subject.object.plural}
				</h2>
				<p className="text-muted-foreground text-xs">
					Nothing is written until you apply. The dry run tells you exactly what
					would change first.
				</p>
			</header>

			{error && (
				<div className="flex items-start gap-2 border-b bg-destructive/10 px-4 py-2 text-destructive text-xs">
					<HugeiconsIcon icon={Alert01Icon} size={14} />
					<span>{error}</span>
				</div>
			)}

			<div className="scroll-fade min-h-0 flex-1 overflow-y-auto p-4">
				{step === "upload" && (
					<div className="space-y-3">
						<Label htmlFor="crm-import-file">CSV file</Label>
						<input
							accept=".csv,text/csv"
							className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm"
							disabled={busy}
							id="crm-import-file"
							onChange={(event) => {
								const file = event.target.files?.[0];
								if (file) {
									void onFile(file);
								}
							}}
							type="file"
						/>
						<p className="text-muted-foreground text-xs">
							The first row is read as a header. Columns are matched to fields
							in the next step.
						</p>
					</div>
				)}

				{step === "map" && job && (
					<div className="space-y-4">
						<div className="text-muted-foreground text-xs">
							{formatNumber(job.row_count)} rows ·{" "}
							{formatNumber(job.columns.length)} columns
							{job.filename ? ` · ${job.filename}` : ""}
						</div>

						<div className="overflow-x-auto">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className="min-w-40">CSV column</TableHead>
										<TableHead className="min-w-48">Sample values</TableHead>
										<TableHead className="min-w-48">Import as</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{job.columns.map((column) => {
										const mapping = mappings.find(
											(m) => m.column_index === column.index
										);
										return (
											<TableRow key={column.index}>
												<TableCell className="font-medium">
													{column.name}
												</TableCell>
												<TableCell className="text-muted-foreground text-xs">
													{column.samples.slice(0, 3).join(", ") || "—"}
												</TableCell>
												<TableCell>
													<NativeSelect
														aria-label={`Import column ${column.name} as`}
														onChange={(event) => {
															const value = event.target.value;
															setMappings((current) =>
																current.map((m) =>
																	m.column_index === column.index
																		? {
																				...m,
																				field_id: value === SKIP ? null : value,
																			}
																		: m
																)
															);
														}}
														value={mapping?.field_id ?? SKIP}
													>
														<NativeSelectOption value={SKIP}>
															Do not import
														</NativeSelectOption>
														{mappableFields.map((field) => (
															<NativeSelectOption
																key={field.id}
																value={field.id}
															>
																{field.name}
															</NativeSelectOption>
														))}
													</NativeSelect>
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						</div>

						<div className="space-y-1">
							<Label htmlFor="crm-import-dedupe">Match existing rows on</Label>
							<NativeSelect
								id="crm-import-dedupe"
								onChange={(event) => setDedupeFieldId(event.target.value)}
								value={dedupeFieldId}
							>
								<NativeSelectOption value="">
									Nothing — create every row
								</NativeSelectOption>
								{mappableFields.map((field) => (
									<NativeSelectOption key={field.id} value={field.id}>
										{field.name}
									</NativeSelectOption>
								))}
							</NativeSelect>
							<p className="text-muted-foreground text-xs">
								With a match field, a row whose value already exists UPDATES
								that record instead of creating a second one.
							</p>
						</div>

						<div className="flex justify-end gap-2">
							<Button
								disabled={busy}
								onClick={() => void runPreview()}
								size="sm"
							>
								{busy ? "Checking…" : "Dry run"}
							</Button>
						</div>
					</div>
				)}

				{step === "preview" && preview && (
					<div className="space-y-4">
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
							<Stat label="Create" value={preview.create_count} />
							<Stat label="Update" value={preview.update_count} />
							<Stat label="Skip" value={preview.skip_count} />
							<Stat label="Errors" value={preview.error_count} />
						</div>

						{preview.unmapped_columns &&
							preview.unmapped_columns.length > 0 && (
								<p className="text-muted-foreground text-xs">
									Not imported: {preview.unmapped_columns.join(", ")}
								</p>
							)}

						{preview.conflicts && preview.conflicts.length > 0 && (
							<div>
								<h3 className="mb-1 font-medium text-sm">
									Conflicts{" "}
									<Badge className="font-normal" variant="secondary">
										{preview.conflicts.length}
									</Badge>
								</h3>
								<p className="mb-2 text-muted-foreground text-xs">
									These rows match an existing record but carry a different
									value. Applying overwrites the existing one.
								</p>
								<div className="overflow-x-auto">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>Row</TableHead>
												<TableHead>Field</TableHead>
												<TableHead>Existing</TableHead>
												<TableHead>Incoming</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{preview.conflicts.slice(0, 25).map((conflict) => (
												<TableRow
													key={`${conflict.row_index}-${conflict.field_id}`}
												>
													<TableCell className="tabular-nums">
														{conflict.row_index + 1}
													</TableCell>
													<TableCell>{conflict.field_slug}</TableCell>
													<TableCell className="text-muted-foreground">
														{String(conflict.existing ?? "—")}
													</TableCell>
													<TableCell>
														{String(conflict.incoming ?? "—")}
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</div>
							</div>
						)}

						{preview.truncated && (
							<p className="text-muted-foreground text-xs">
								The per-row detail above is a sample. The counts are exact for
								the whole file.
							</p>
						)}

						<div className="flex justify-end gap-2">
							<Button
								disabled={busy}
								onClick={() => setStep("map")}
								size="sm"
								variant="ghost"
							>
								Back to mapping
							</Button>
							<Button disabled={busy} onClick={() => void runApply()} size="sm">
								{busy
									? "Importing…"
									: `Import ${preview.create_count + preview.update_count} rows`}
							</Button>
						</div>
					</div>
				)}

				{step === "apply" && result && (
					<div className="space-y-3">
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
							<Stat label="Created" value={result.created} />
							<Stat label="Updated" value={result.updated} />
							<Stat label="Skipped" value={result.skipped} />
							<Stat label="Failed" value={result.failed} />
						</div>
						<div className="flex justify-end">
							<Button
								onClick={() => {
									setStep("upload");
									setJob(null);
									setPreview(null);
									setResult(null);
									setMappings([]);
									setDedupeFieldId("");
								}}
								size="sm"
								variant="ghost"
							>
								Import another file
							</Button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function Stat({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-md border bg-card p-3">
			<div className="font-medium text-lg tabular-nums">
				{formatNumber(value)}
			</div>
			<div className="text-muted-foreground text-xs">{label}</div>
		</div>
	);
}
