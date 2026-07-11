#!/usr/bin/env bun
// Vendor termcn (https://www.termcn.dev) OpenTUI components into apps/tui.
//
// termcn ships shadcn-style registry items: each component is a JSON document at
// https://www.termcn.dev/r/<name>.json carrying its source files (with a `target`
// path), npm `dependencies`, and `registryDependencies` (URLs of other registry
// items it needs). The official add path is `npx shadcn@latest add @termcn/<name>`,
// but the shadcn CLI assumes a Tailwind/web project and chokes on a bare TUI, so we
// vendor instead: fetch each item, recurse its registry deps, and write every file
// to its target under apps/tui. Run once and commit the result; this script exists
// for reproducibility, not at install time.
//
// Usage: bun run scripts/vendor-termcn.ts [name ...]
//   With no args, vendors the curated ROOTS set below.

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const REGISTRY_HOST = "https://www.termcn.dev";
const ROOT_DIR = resolve(import.meta.dir, "..");

// Curated starter set covering every tab's needs. Transitive registry deps
// (theme-provider, hooks, primitives) are pulled in automatically.
const ROOTS = [
	// theme + primitives
	"opentui-theme-provider",
	"opentui-box",
	"opentui-card",
	"opentui-panel",
	"opentui-divider",
	"opentui-scroll-view",
	"opentui-stack",
	"opentui-columns",
	"opentui-center",
	"opentui-spacer",
	// text
	"opentui-heading",
	"opentui-big-text",
	"opentui-markdown",
	"opentui-streaming-text",
	"opentui-code",
	"opentui-link",
	// list / table
	"opentui-list",
	"opentui-table",
	"opentui-key-value",
	// inputs
	"opentui-text-input",
	"opentui-text-area",
	"opentui-select",
	"opentui-search-input",
	"opentui-multi-select",
	"opentui-checkbox",
	"opentui-toggle",
	// feedback / status
	"opentui-badge",
	"opentui-tag",
	"opentui-spinner",
	"opentui-progress-bar",
	"opentui-status-message",
	"opentui-toast",
	"opentui-alert",
	"opentui-banner",
	"opentui-skeleton",
	"opentui-gauge",
	// overlay / nav
	"opentui-dialog",
	"opentui-modal",
	"opentui-command-palette",
	"opentui-tabs",
	"opentui-menu",
	"opentui-help-screen",
	"opentui-tooltip",
	"opentui-confirm",
	// chat
	"opentui-chat-message",
	"opentui-tool-call",
	"opentui-thinking-block",
	"opentui-model-selector",
];

interface RegistryFile {
	content: string;
	path: string;
	target?: string;
}

interface RegistryItem {
	dependencies?: string[];
	files?: RegistryFile[];
	name: string;
	registryDependencies?: string[];
}

// The base (Ink/framework-agnostic) `theme-provider` is pulled transitively by
// `theme-default`, but it writes an untargeted `theme-provider.tsx` at the repo
// root that duplicates and is superseded by `opentui-theme-provider`
// (`components/ui/theme-provider.tsx`, which every component imports). Skip it.
const SKIP_ITEMS = new Set(["theme-provider"]);

const HOOK_PATH = /(?:^|\/)hooks\/(.+)$/;
const LIB_PATH = /(?:^|\/)lib\/(.+)$/;
const REGISTRY_PREFIX = /^registry\/[^/]+\//;

const npmDeps = new Map<string, string>();
const visited = new Set<string>();

// Registry deps often point at the non-www host, which 307-redirects to www.
// Normalize so transitive resolution does not fail on the redirect.
const normalizeUrl = (raw: string): string => {
	const url = raw
		.replace("http://termcn.dev/", "https://www.termcn.dev/")
		.replace("https://termcn.dev/", "https://www.termcn.dev/");
	if (url.startsWith("http")) {
		return url;
	}
	return `${REGISTRY_HOST}/r/${url}.json`;
};

const nameToUrl = (name: string): string =>
	name.startsWith("http")
		? normalizeUrl(name)
		: `${REGISTRY_HOST}/r/${name}.json`;

const targetFor = (file: RegistryFile): string => {
	if (file.target && file.target.trim().length > 0) {
		return file.target;
	}
	// Fall back from the source path when no target is given. Hooks live under
	// `registry/hooks/<x>` and must land in `hooks/<x>` (components import them as
	// `@/hooks/<x>`); everything else strips the leading `registry/<framework>/`.
	const hookMatch = file.path.match(HOOK_PATH);
	if (hookMatch) {
		return `hooks/${hookMatch[1]}`;
	}
	const libMatch = file.path.match(LIB_PATH);
	if (libMatch) {
		return `lib/${libMatch[1]}`;
	}
	return file.path.replace(REGISTRY_PREFIX, "");
};

async function vendorOne(urlOrName: string): Promise<void> {
	const url = nameToUrl(urlOrName);
	if (visited.has(url)) {
		return;
	}
	visited.add(url);

	const resp = await fetch(url, { redirect: "follow" });
	if (!resp.ok) {
		process.stderr.write(`skip ${url} (HTTP ${resp.status})\n`);
		return;
	}
	const item = (await resp.json()) as RegistryItem;

	if (SKIP_ITEMS.has(item.name)) {
		process.stderr.write(`skip ${item.name} (superseded)\n`);
		return;
	}

	for (const dep of item.dependencies ?? []) {
		// Pin nothing here; record the spec so package.json can carry it.
		npmDeps.set(dep, "*");
	}

	for (const reg of item.registryDependencies ?? []) {
		await vendorOne(normalizeUrl(reg));
	}

	for (const file of item.files ?? []) {
		const rel = targetFor(file);
		const dest = join(ROOT_DIR, rel);
		await mkdir(dirname(dest), { recursive: true });
		// termcn's sources target a richer OpenTUI prop surface than the installed
		// @opentui/core (e.g. borderStyle "round"/"bold", text inverse/underline,
		// box borderBottom) which OpenTUI accepts at runtime via parseBorderStyle /
		// by ignoring unknown props. They are not type-clean against 0.4.2, so we
		// mark the vendored copies @ts-nocheck - they are third-party files we do
		// not edit, and our own src/** stays fully type-checked.
		const content = file.content.startsWith("// @ts-nocheck")
			? file.content
			: `// @ts-nocheck - vendored termcn component, see scripts/vendor-termcn.ts\n${file.content}`;
		await Bun.write(dest, content);
		process.stdout.write(`wrote ${rel}\n`);
	}
}

const roots = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ROOTS;

for (const root of roots) {
	await vendorOne(root);
}

process.stdout.write("\nnpm dependencies discovered:\n");
const sorted = [...npmDeps.keys()]
	.filter((d) => !d.startsWith("@opentui/"))
	.sort();
process.stdout.write(`${JSON.stringify(sorted, null, 2)}\n`);
