import { invoke } from "@tauri-apps/api/core";

/** Read a UTF-8 text file from disk by absolute path. */
export function readProjectFile(path: string): Promise<string> {
	return invoke<string>("read_project_file", { path });
}

/** Write a UTF-8 text file to disk by absolute path. */
export function writeProjectFile(path: string, content: string): Promise<void> {
	return invoke<void>("write_project_file", { path, content });
}

/** List markdown files (recursive, bounded) under a workspace folder. */
export function listProjectMarkdown(folder: string): Promise<string[]> {
	return invoke<string[]>("list_project_markdown", { folder });
}

/** The trailing file name of an absolute path (handles `/` and `\\`). */
export function basename(path: string): string {
	const parts = path.split(/[/\\]/);
	return parts.at(-1) ?? path;
}
