import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchEmbeddingModel,
	fetchReindexStatus,
	type ReindexStatus,
	setEmbeddingModel,
	triggerReindex,
} from "@/src/lib/api/spaces.ts";
import previewStyles from "./settings-preview.module.css";
import type { PreviewStyle } from "./settings-preview-style.ts";

export function EmbeddingCard({ target }: { target: ApiTarget }) {
	const [status, setStatus] = useState<ReindexStatus | null>(null);
	const [modelInput, setModelInput] = useState("");
	const [baseUrlInput, setBaseUrlInput] = useState("");
	const [dimsInput, setDimsInput] = useState("");
	const [modelLoadError, setModelLoadError] = useState(false);
	const [statusLoadError, setStatusLoadError] = useState(false);
	const [dimsError, setDimsError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const tl = useLiteralMessages();
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const refresh = useCallback(async () => {
		try {
			const s = await fetchReindexStatus(target);
			setStatus(s);
			setStatusLoadError(false);
			return s;
		} catch {
			setStatusLoadError(true);
			return null;
		}
	}, [target]);

	const loadModel = useCallback(async () => {
		setModelLoadError(false);
		try {
			const model = await fetchEmbeddingModel(target);
			setModelInput(model.modelId);
			setBaseUrlInput(model.baseUrl ?? "");
			setDimsInput(model.dims ? String(model.dims) : "");
		} catch {
			setModelLoadError(true);
		}
	}, [target]);

	useEffect(() => {
		void loadModel();
		void refresh();
	}, [loadModel, refresh]);

	const retryReads = useCallback(() => {
		void loadModel();
		void refresh();
	}, [loadModel, refresh]);

	// Poll while a reindex is running so the progress bar advances.
	useEffect(() => {
		if (status?.running && !pollRef.current) {
			pollRef.current = setInterval(() => {
				void refresh().then((s) => {
					if (s && !s.running && pollRef.current) {
						clearInterval(pollRef.current);
						pollRef.current = null;
					}
				});
			}, 1500);
		}
		return () => {
			if (pollRef.current) {
				clearInterval(pollRef.current);
				pollRef.current = null;
			}
		};
	}, [status?.running, refresh]);

	const applyModel = useCallback(async () => {
		const rawDims = dimsInput.trim();
		const dims = rawDims ? Number(rawDims) : undefined;
		if (
			rawDims &&
			(dims === undefined || !Number.isSafeInteger(dims) || dims <= 0)
		) {
			const error = "Dimensions must be a positive whole number";
			setDimsError(error);
			toast.error(error);
			return;
		}
		setDimsError(null);
		setBusy(true);
		try {
			await setEmbeddingModel(
				target,
				modelInput.trim(),
				baseUrlInput.trim() || undefined,
				Number.isFinite(dims) ? dims : undefined
			);
			toast.success("Embedding model changed; reindexing in the background");
			await refresh();
		} catch (e) {
			toast.error(
				e instanceof Error ? e.message : "Failed to change embedding model"
			);
		} finally {
			setBusy(false);
		}
	}, [target, modelInput, baseUrlInput, dimsInput, refresh]);

	const reindexNow = useCallback(async () => {
		setBusy(true);
		try {
			await triggerReindex(target);
			await refresh();
		} catch {
			toast.error("Couldn't start reindex");
		} finally {
			setBusy(false);
		}
	}, [target, refresh]);

	const pending = status?.pendingChunks ?? 0;
	const totalChunks = status?.totalChunks ?? 0;
	const doneChunks = Math.max(0, totalChunks - pending);
	const pct =
		totalChunks > 0 ? Math.round((doneChunks / totalChunks) * 100) : 0;

	const progressStyle: PreviewStyle = {
		"--settings-preview-progress": `${pct}%`,
	};
	return (
		<div
			aria-labelledby="embedding-settings-title"
			className="space-y-4 rounded-lg bg-muted/40 p-4"
			role="region"
		>
			<div>
				<p className="font-medium text-sm" id="embedding-settings-title">
					Default embedding model
				</p>
				<p className="text-muted-foreground text-xs">
					Used to embed Spaces pages for RAG. Changing it re-embeds every
					document (old vectors are not comparable across models).
				</p>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="embed-model">Model id</Label>
				<Input
					id="embed-model"
					onChange={(e) => setModelInput(e.target.value)}
					placeholder="nomic-embed-text-v1.5"
					value={modelInput}
				/>
			</div>
			<div className="grid grid-cols-2 gap-3">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="embed-base">Base URL (optional)</Label>
					<Input
						id="embed-base"
						onChange={(e) => setBaseUrlInput(e.target.value)}
						placeholder="http://127.0.0.1:8081"
						value={baseUrlInput}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="embed-dims">Dimensions (optional)</Label>
					<Input
						aria-describedby={dimsError ? "embed-dims-error" : undefined}
						aria-invalid={dimsError ? true : undefined}
						id="embed-dims"
						onChange={(e) => {
							setDimsInput(e.target.value);
							setDimsError(null);
						}}
						placeholder="768"
						value={dimsInput}
					/>
					{dimsError ? (
						<p
							className="text-status-destructive text-xs"
							id="embed-dims-error"
							role="alert"
						>
							{dimsError}
						</p>
					) : null}
				</div>
			</div>
			{modelLoadError || statusLoadError ? (
				<div className="flex items-center justify-between gap-3">
					<p className="text-status-destructive text-xs" role="alert">
						{modelLoadError && statusLoadError
							? "Couldn't load embedding model or reindex status."
							: modelLoadError
								? "Couldn't load the embedding model."
								: "Couldn't load reindex status."}
					</p>
					<Button onClick={retryReads} size="sm" variant="outline">
						Retry
					</Button>
				</div>
			) : null}
			<div className="flex items-center gap-2">
				<Button loading={busy} onClick={applyModel} size="sm">
					Change & reindex
				</Button>
				<Button
					disabled={busy || status?.running === true || pending === 0}
					onClick={reindexNow}
					size="sm"
					variant="ghost"
				>
					{tl("Reindex stale ({pending})", { pending: String(pending) })}
				</Button>
			</div>

			{status ? (
				<div className="space-y-1">
					<div className="flex justify-between text-muted-foreground text-xs">
						<span>
							{status.running
								? "Reindexing…"
								: pending > 0
									? tl("{pending} of {totalChunks} chunks stale", {
											pending: String(pending),
											totalChunks: String(totalChunks),
										})
									: "All embeddings up to date"}
						</span>
						<span className="tabular-nums">{pct}%</span>
					</div>
					<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
						<div
							className={`h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none ${previewStyles.progress}`}
							style={progressStyle}
						/>
					</div>
				</div>
			) : null}
		</div>
	);
}
