import { invokeWhenReady } from "./tauri-ready.ts";

/** Read a UTF-8 text file from disk by absolute path. */
export function readProjectFile(path: string): Promise<string> {
	return invokeWhenReady<string>("read_project_file", { path });
}

export function readProjectFileBinary(path: string): Promise<string> {
	return invokeWhenReady<string>("read_project_file_binary", { path });
}

export function writeProjectFileBinary(
	path: string,
	blob: string
): Promise<void> {
	return invokeWhenReady<void>("write_project_file_binary", { path, blob });
}

/** Read a committed file without losing blank lines through the shell bridge. */
export async function readGitProjectFile(
	folder: string,
	path: string
): Promise<string> {
	return invokeWhenReady<string>("read_git_project_file", { folder, path });
}

/** Write a UTF-8 text file to disk by absolute path. */
export function writeProjectFile(path: string, content: string): Promise<void> {
	return invokeWhenReady<void>("write_project_file", { path, content });
}

/** Write one Markdown file below a selected project folder. */
export function writeProjectMarkdown(
	root: string,
	relativePath: string,
	content: string
): Promise<void> {
	return invokeWhenReady<void>("write_project_markdown", {
		content,
		relativePath,
		root,
	});
}

/** List markdown files (recursive, bounded) under a workspace folder. */
export function listProjectMarkdown(folder: string): Promise<string[]> {
	return invokeWhenReady<string[]>("list_project_markdown", { folder });
}

/** The trailing file name of an absolute path (handles `/` and `\\`). */
export function basename(path: string): string {
	const parts = path.split(/[/\\]/);
	return parts.at(-1) ?? path;
}

/** Join a folder and file name using the separator already present in `folder`. */
export function joinPath(folder: string, name: string): string {
	const sep = folder.includes("\\") ? "\\" : "/";
	const trimmed = folder.replace(/[/\\]+$/, "");
	return `${trimmed}${sep}${name}`;
}

/**
 * Candidate instruction filenames, preferred order. The Agents.md convention
 * leads; CLAUDE.md is accepted when already present so we don't fork instructions.
 */
export const PROJECT_AGENTS_CANDIDATES = [
	"AGENTS.md",
	"agents.md",
	"Agents.md",
	"CLAUDE.md",
	"claude.md",
] as const;

/** Result of resolving a project's on-disk instruction file. */
export interface ProjectAgentsFile {
	/** File body, or `""` when nothing exists yet. */
	content: string;
	/** Whether an instruction file was found on disk. */
	existed: boolean;
	/** Leaf name that was found, or `"AGENTS.md"` when creating. */
	fileName: string;
	/** Absolute path that will be written on save (existing file, or AGENTS.md). */
	path: string;
}

/**
 * Auto-detect a project's instruction markdown (`AGENTS.md` / `agents.md` /
 * `CLAUDE.md`, …). When none exist, returns an empty body targeted at
 * `AGENTS.md` so the first save creates it.
 */
export async function resolveProjectAgentsFile(
	folder: string
): Promise<ProjectAgentsFile> {
	for (const fileName of PROJECT_AGENTS_CANDIDATES) {
		const path = joinPath(folder, fileName);
		try {
			const content = await readProjectFile(path);
			return { path, content, existed: true, fileName };
		} catch {
			// Try the next candidate — missing file is the common case.
		}
	}
	return {
		path: joinPath(folder, "AGENTS.md"),
		content: "",
		existed: false,
		fileName: "AGENTS.md",
	};
}
