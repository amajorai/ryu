import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { open } from "@tauri-apps/plugin-dialog";
import {
	Download,
	FolderOpen,
	GitBranch,
	GitCommitHorizontal,
	RefreshCw,
	Upload,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	commitPush,
	fetchGitStatus,
	type GitStatus,
	initializeGit,
} from "@/src/lib/api/git.ts";
import {
	createMemory,
	type Memory,
	updateMemory,
} from "@/src/lib/api/memory.ts";
import { getPreference, setPreference } from "@/src/lib/api/preferences.ts";
import {
	listProjectMarkdown,
	readProjectFile,
	writeProjectMarkdown,
} from "@/src/lib/files.ts";
import {
	exportMemoryGitTree,
	MEMORY_GIT_ROOT,
	memoryRepoRelativePath,
	parseMemoryMarkdown,
} from "@/src/lib/memory-git.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";

const MEMORY_GIT_PATH_KEY = "ryu.memory.git-root.v1";
const MEMORY_GIT_ROOT_PREF_KEY = "memory.git-root";

function storedRoot(): string {
	if (globalThis.window === undefined) {
		return "";
	}
	return window.localStorage.getItem(MEMORY_GIT_PATH_KEY) ?? "";
}

function statusLabel(status: GitStatus | null): string {
	if (!status?.is_repo) {
		return "Not a Git repository";
	}
	const changed =
		status.changed_files_count === 1
			? "1 changed file"
			: `${status.changed_files_count} changed files`;
	return `${status.branch ?? "detached HEAD"} · ${changed}`;
}

export function MemoryGitSourceCard({
	memories,
	onImported,
	target,
}: {
	memories: Memory[];
	onImported: () => void;
	target?: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const activeNode = useActiveNode();
	const { canUseNativeShell } = useAppSurface();
	const apiTarget = target ?? toTarget(activeNode);
	const [root, setRoot] = useState(storedRoot);
	const [status, setStatus] = useState<GitStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refreshStatus = useCallback(async () => {
		if (!root) {
			setStatus(null);
			return;
		}
		setStatus(await fetchGitStatus(apiTarget, root));
	}, [apiTarget, root]);

	useEffect(() => {
		void refreshStatus();
	}, [refreshStatus]);

	useEffect(() => {
		if (root) {
			return;
		}
		getPreference(apiTarget, MEMORY_GIT_ROOT_PREF_KEY)
			.then((saved) => {
				if (saved) {
					window.localStorage.setItem(MEMORY_GIT_PATH_KEY, saved);
					setRoot(saved);
				}
			})
			.catch(() => undefined);
	}, [apiTarget, root]);

	const chooseFolder = useCallback(async () => {
		const selected = await open({ directory: true, multiple: false });
		if (!isNativeText(selected)) {
			return;
		}
		window.localStorage.setItem(MEMORY_GIT_PATH_KEY, selected);
		void setPreference(apiTarget, MEMORY_GIT_ROOT_PREF_KEY, selected).catch(
			() => {
				setError(
					"The folder was selected locally, but Core could not save the Memory Git binding."
				);
			}
		);
		setRoot(selected);
		setNotice(null);
		setError(null);
	}, [apiTarget]);

	const initialize = useCallback(async () => {
		if (!root) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await initializeGit(apiTarget, root);
			if (!result.success) {
				throw new Error(result.error ?? "Git initialization failed");
			}
			setNotice(
				"Git repository initialized. Export the source files when ready."
			);
			await refreshStatus();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Git initialization failed"
			);
		} finally {
			setBusy(false);
		}
	}, [apiTarget, refreshStatus, root]);

	const exportSource = useCallback(async () => {
		if (!(root && status?.is_repo)) {
			setError("Choose or initialize a Git repository first.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const files = exportMemoryGitTree(memories);
			for (const file of files) {
				await writeProjectMarkdown(root, file.path, file.content);
			}
			setNotice(
				tl(
					"{memoryCount} memories exported as source Markdown. Vectors stay local to this node.",
					{ memoryCount: String(memories.length) }
				)
			);
			await refreshStatus();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Memory export failed");
		} finally {
			setBusy(false);
		}
	}, [memories, refreshStatus, root, status?.is_repo, tl]);

	const importSource = useCallback(async () => {
		if (!(root && status?.is_repo)) {
			setError("Choose or initialize a Git repository first.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const paths = await listProjectMarkdown(root);
			const sourceFiles = paths
				.map((path) => ({
					absolute: path,
					relative: memoryRepoRelativePath(root, path),
				}))
				.filter(
					(file): file is { absolute: string; relative: string } =>
						file.relative !== null &&
						file.relative !== `${MEMORY_GIT_ROOT}/index.md`
				);
			const existing = new Map(memories.map((memory) => [memory.id, memory]));
			let imported = 0;
			for (const file of sourceFiles) {
				const content = await readProjectFile(file.absolute);
				const parsed = parseMemoryMarkdown(file.relative, content);
				if (!parsed) {
					continue;
				}
				const input = {
					category: parsed.category,
					content: parsed.content,
					importance: parsed.importance,
					scope: parsed.scope,
					scopeId: parsed.scopeId,
					tags: parsed.tags,
					whenToUse: parsed.whenToUse,
				};
				if (existing.has(parsed.id)) {
					await updateMemory(apiTarget, parsed.id, input);
				} else {
					await createMemory(apiTarget, input);
				}
				imported += 1;
			}
			onImported();
			setNotice(
				tl(
					"{importedCount, plural, one {{importedLabel} memory source file} other {{importedLabel} memory source files}} imported. Git history remains in the repository.",
					{ importedCount: imported, importedLabel: String(imported) }
				)
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Memory import failed");
		} finally {
			setBusy(false);
		}
	}, [apiTarget, memories, onImported, root, status?.is_repo, tl]);

	const commit = useCallback(async () => {
		if (!(root && status?.is_repo)) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await commitPush(
				apiTarget,
				root,
				"Update Ryu memory Markdown",
				undefined,
				"commit"
			);
			if (!result.success) {
				throw new Error(result.error ?? "Git commit failed");
			}
			setNotice(
				result.committed
					? "Memory Markdown committed to Git."
					: "Git had nothing new to commit."
			);
			await refreshStatus();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Git commit failed");
		} finally {
			setBusy(false);
		}
	}, [apiTarget, refreshStatus, root, status?.is_repo]);

	if (!(canUseNativeShell && isLocalNode(activeNode))) {
		return (
			<Card appearance="memory-source" borderTone="subtle">
				<CardHeader>
					<CardTitle>Git-backed memory</CardTitle>
					<CardDescription>
						{canUseNativeShell
							? "Select the local node to manage a Git-backed memory source on this device."
							: "Memory can be exported as source-only Markdown under memory/ in a local Git repository. This control is available in the desktop app."}
					</CardDescription>
				</CardHeader>
			</Card>
		);
	}

	return (
		<Card appearance="memory-source" borderTone="subtle">
			<CardHeader spacing="chart">
				<div className="flex items-start justify-between gap-3">
					<div>
						<CardTitle layout="badge-row">
							<GitBranch className="size-4" />
							Git-backed memory
						</CardTitle>
						<CardDescription className="mt-1">
							Track durable memory as reviewable Markdown. The encrypted store,
							vectors, and conversation provenance never enter Git.
						</CardDescription>
					</div>
					{status?.is_repo ? (
						<Badge variant="secondary">{status.branch ?? "Git"}</Badge>
					) : null}
				</div>
				<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
					<FolderOpen className="size-3.5" />
					<span className="max-w-full truncate">
						{root || "No repository selected"}
					</span>
					{root ? <span>· {statusLabel(status)}</span> : null}
				</div>
			</CardHeader>
			<CardContent layout="memory-actions">
				<Button
					disabled={busy}
					onClick={() => void chooseFolder()}
					size="sm"
					variant="outline"
				>
					<FolderOpen className="size-4" />
					{root ? "Change folder" : "Choose Git folder"}
				</Button>
				{root && !status?.is_repo ? (
					<Button
						disabled={busy}
						onClick={() => void initialize()}
						size="sm"
						variant="outline"
					>
						<GitBranch className="size-4" />
						Initialize Git
					</Button>
				) : null}
				{status?.is_repo ? (
					<>
						<Button
							disabled={busy}
							onClick={() => void exportSource()}
							size="sm"
						>
							<Download className="size-4" />
							Export Markdown
						</Button>
						<Button
							disabled={busy}
							onClick={() => void importSource()}
							size="sm"
							variant="outline"
						>
							<Upload className="size-4" />
							Import changes
						</Button>
						<Button
							disabled={busy || !status.dirty}
							onClick={() => void commit()}
							size="sm"
							variant="outline"
						>
							<GitCommitHorizontal className="size-4" />
							Commit
						</Button>
						<Button
							aria-label="Refresh Git status"
							disabled={busy}
							onClick={() => void refreshStatus()}
							size="icon"
							variant="ghost"
						>
							<RefreshCw className="size-4" />
						</Button>
					</>
				) : null}
				{notice ? (
					<p className="basis-full text-muted-foreground text-xs">{notice}</p>
				) : null}
				{error ? (
					<p className="basis-full text-status-destructive text-xs">{error}</p>
				) : null}
			</CardContent>
		</Card>
	);
}
