import { parse, stringify } from "yaml";
import { z } from "zod";
import type {
	Memory,
	MemoryCategory,
	MemoryScope,
} from "@/src/lib/api/memory.ts";
import { MEMORY_CATEGORIES } from "@/src/lib/api/memory.ts";

/** The folder inside a user-selected repository that Ryu owns for memories. */
export const MEMORY_GIT_ROOT = "memory";
export const MEMORY_GIT_FORMAT = "ryu-memory-markdown";
export const MEMORY_GIT_VERSION = "1.0.0";

export interface MemoryGitFile {
	content: string;
	path: string;
}

export interface ParsedMemoryMarkdown {
	category: MemoryCategory;
	content: string;
	createdAt?: number;
	id: string;
	importance: number;
	path: string;
	scope: MemoryScope;
	scopeId: string | null;
	tags: string[];
	updatedAt?: number;
	whenToUse: string | null;
}

/** YAML frontmatter is normalized field by field so malformed optional fields
 * retain the Git format's existing defaults. Only this format's four scopes
 * are accepted; API-only agent scope remains unsupported here. */
const memoryFrontmatterSchema = z.object({
	type: z.literal("memory"),
	id: z.unknown().optional(),
	scope: z.unknown().optional(),
	category: z.unknown().optional(),
	importance: z.unknown().optional(),
	scope_id: z.unknown().optional(),
	when_to_use: z.unknown().optional(),
	created_at: z.unknown().optional(),
	updated_at: z.unknown().optional(),
	tags: z.unknown().optional(),
});
const memoryGitScopeSchema = z.enum(["user", "node", "project", "org"]);
const memoryGitCategorySchema = z.enum(MEMORY_CATEGORIES);
const memoryIntegerSchema = z.number().refine(Number.isInteger);
const memoryTagsSchema = z.array(z.unknown());
type MemoryFrontmatterInput = Parameters<
	typeof memoryFrontmatterSchema.parse
>[0];

function ensureInteger(
	value: MemoryFrontmatterInput,
	fallback: number
): number {
	const parsed = memoryIntegerSchema.safeParse(value);
	return parsed.success ? parsed.data : fallback;
}

function normalizeOptionalString(value: MemoryFrontmatterInput): string | null {
	const parsed = z.string().safeParse(value);
	return parsed.success && parsed.data.trim() ? parsed.data.trim() : null;
}

function memoryPath(memory: Memory): string {
	return `${MEMORY_GIT_ROOT}/${memory.scope}/${memory.id}.md`;
}

function firstLine(value: string): string {
	return value.split(/\r?\n/, 1)[0]?.trim().slice(0, 120) || "Memory";
}

function memoryMarkdown(memory: Memory): string {
	const frontmatter = {
		type: "memory",
		id: memory.id,
		title: firstLine(memory.content),
		scope: memory.scope,
		scope_id: memory.scopeId,
		category: memory.category,
		importance: memory.importance,
		when_to_use: memory.whenToUse,
		tags: memory.tags,
		created_at: memory.createdAt,
		updated_at: memory.updatedAt,
	};
	return `---\n${stringify(frontmatter)}---\n${memory.content.trim()}\n`;
}

function indexMarkdown(memories: Memory[]): string {
	const lines = memories
		.slice()
		.sort((a, b) => memoryPath(a).localeCompare(memoryPath(b)))
		.map((memory) => `- [${memory.id}](${memory.scope}/${memory.id}.md)`)
		.join("\n");
	return `---\nokf: "0.1"\ntype: bundle\nformat: ${MEMORY_GIT_FORMAT}\nversion: "${MEMORY_GIT_VERSION}"\n---\n# Ryu Memory\n\nThis is a source-only Markdown view of the selected Ryu memories.\nVectors, encrypted database rows, conversation provenance, and provider credentials stay local to the Ryu node.\n\n${lines || "_No memories exported._"}\n`;
}

/** Build the deterministic Markdown tree written to the selected Git folder. */
export function exportMemoryGitTree(memories: Memory[]): MemoryGitFile[] {
	const sorted = memories
		.slice()
		.sort((a, b) => memoryPath(a).localeCompare(memoryPath(b)));
	return [
		{ path: `${MEMORY_GIT_ROOT}/index.md`, content: indexMarkdown(sorted) },
		...sorted.map((memory) => ({
			path: memoryPath(memory),
			content: memoryMarkdown(memory),
		})),
	];
}

function splitFrontmatter(content: string) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) {
		return { body: "", yaml: "" };
	}
	return { body: match[2] ?? "", yaml: match[1] ?? "" };
}

/** Parse one source file; index.md and non-memory Markdown are intentionally ignored. */
export function parseMemoryMarkdown(
	path: string,
	content: string
): ParsedMemoryMarkdown | null {
	if (!path.startsWith(`${MEMORY_GIT_ROOT}/`) || path.endsWith("/index.md")) {
		return null;
	}
	const { body, yaml } = splitFrontmatter(content);
	if (!yaml) {
		return null;
	}
	const raw: MemoryFrontmatterInput = parse(yaml);
	const decoded = memoryFrontmatterSchema.safeParse(raw);
	if (!decoded.success) {
		return null;
	}
	const frontmatter = decoded.data;
	const id = normalizeOptionalString(frontmatter.id);
	if (!id || id.includes("/") || id.includes("\\")) {
		throw new Error(`${path}: memory id is missing or invalid`);
	}
	const scopeValue = normalizeOptionalString(frontmatter.scope) ?? "user";
	const scope = memoryGitScopeSchema.safeParse(scopeValue);
	if (!scope.success) {
		throw new Error(`${path}: unsupported memory scope`);
	}
	const categoryValue =
		normalizeOptionalString(frontmatter.category) ?? "user_fact";
	const category = memoryGitCategorySchema.safeParse(categoryValue);
	if (!category.success) {
		throw new Error(`${path}: unsupported memory category`);
	}
	const contentText = body.trim();
	if (!contentText) {
		throw new Error(`${path}: memory content is empty`);
	}
	const decodedTags = memoryTagsSchema.safeParse(frontmatter.tags);
	const tags: string[] = [];
	if (decodedTags.success) {
		for (const tag of decodedTags.data) {
			const text = normalizeOptionalString(tag);
			if (text) {
				tags.push(text);
			}
		}
	}

	return {
		category: category.data,
		content: contentText,
		createdAt: ensureInteger(frontmatter.created_at, 0) || undefined,
		id,
		importance: Math.min(
			5,
			Math.max(1, ensureInteger(frontmatter.importance, 3))
		),
		path,
		tags,
		scope: scope.data,
		scopeId: normalizeOptionalString(frontmatter.scope_id),
		updatedAt: ensureInteger(frontmatter.updated_at, 0) || undefined,
		whenToUse: normalizeOptionalString(frontmatter.when_to_use),
	};
}

/** Normalize an absolute file path and return its repository-relative memory path. */
export function memoryRepoRelativePath(
	root: string,
	absolutePath: string
): string | null {
	const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
	const normalizedPath = absolutePath.replaceAll("\\", "/");
	const prefix = `${normalizedRoot}/${MEMORY_GIT_ROOT}/`;
	if (!normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())) {
		return null;
	}
	return normalizedPath.slice(normalizedRoot.length + 1);
}
