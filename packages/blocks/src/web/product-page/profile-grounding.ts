import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ProductProfile,
	ProductRelatedLink,
	ProductSource,
} from "./profile-types.ts";

// Node-only: tests import this module to prove each profile entry is grounded in
// a real repo file. Pages never import it (it reads the file system).

/** The one file allowed to back a displayed price. */
export const PRICING_SOURCE_PATH =
	"packages/blocks/src/web/data/standalone-pricing.ts";

const DOCS_CONTENT_DIR = "apps/fumadocs/content/docs";
const WEB_PUBLIC_DIR = "apps/web/public";
const WEB_CONTENT_DIR = "apps/web/content";
const COMPARISONS_DIR = "apps/web/src/data/comparisons";

const PRICE = /\$\s?\d/;
/** `@ryuhq/services*` are not on npm (UNPUBLISHED_SERVICE_PACKAGES in apps/web). */
const UNPUBLISHED_INSTALL =
	/\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b[^\n]*@ryuhq\/services/;

const RELATED_DIRS: Record<
	Exclude<ProductRelatedLink["kind"], "docs">,
	string
> = {
	guide: "guides",
	help: "help",
	blog: "blog",
};

/** The repository root, resolved from this file. */
export function repoRoot(): string {
	return fileURLToPath(new URL("../../../../../", import.meta.url));
}

/** Collapse runs of whitespace so quotes survive reflowed source. */
export function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function isFile(path: string): boolean {
	return existsSync(path) && statSync(path).isFile();
}

/** The fumadocs file a "/docs/…" path resolves to, or undefined. */
export function resolveDocsPath(
	docsPath: string,
	root = repoRoot()
): string | undefined {
	if (!(docsPath === "/docs" || docsPath.startsWith("/docs/"))) {
		return undefined;
	}
	const rest = docsPath.replace(/^\/docs\/?/, "").replace(/[#?].*$/, "");
	const base = join(root, DOCS_CONTENT_DIR, rest);
	for (const candidate of [`${base}.mdx`, join(base, "index.mdx")]) {
		if (isFile(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function sourceErrors(
	where: string,
	source: ProductSource,
	root: string
): string[] {
	const { path, quote } = source;
	if (isAbsolute(path) || normalize(path).startsWith("..")) {
		return [`${where}: source path must be repo-relative (${path})`];
	}
	const file = join(root, path);
	if (!isFile(file)) {
		return [`${where}: source file does not exist (${path})`];
	}
	if (
		quote !== undefined &&
		!normalizeWhitespace(readFileSync(file, "utf8")).includes(
			normalizeWhitespace(quote)
		)
	) {
		return [`${where}: quote not found in ${path}: "${quote}"`];
	}
	return [];
}

function priceErrors(
	where: string,
	source: ProductSource,
	texts: readonly (string | undefined)[]
): string[] {
	if (source.path === PRICING_SOURCE_PATH) {
		return [];
	}
	return texts.some((text) => text && PRICE.test(text))
		? [`${where}: a price must come from ${PRICING_SOURCE_PATH}`]
		: [];
}

function relatedErrors(link: ProductRelatedLink, root: string): string[] {
	const where = `related "${link.label}"`;
	if (link.kind === "docs") {
		return resolveDocsPath(link.href, root)
			? []
			: [`${where}: docs path does not resolve (${link.href})`];
	}
	const dir = RELATED_DIRS[link.kind];
	const match = link.href.match(new RegExp(`^/${dir}/([a-z0-9-]+)$`));
	const file = match ? join(root, WEB_CONTENT_DIR, dir, `${match[1]}.mdx`) : "";
	if (!(match && isFile(file))) {
		return [`${where}: no ${link.kind} page at ${link.href}`];
	}
	return /^draft:\s*true\s*$/m.test(readFileSync(file, "utf8"))
		? [`${where}: ${link.href} is a draft`]
		: [];
}

/** Sourced entries: [label, source, visible texts checked for prices]. */
function sourcedEntries(
	profile: ProductProfile
): [string, ProductSource, (string | undefined)[]][] {
	const entries: [string, ProductSource, (string | undefined)[]][] = [];
	for (const fact of profile.facts) {
		entries.push([`fact "${fact.label}"`, fact.source, [fact.value]]);
	}
	for (const sample of profile.code ?? []) {
		entries.push([`code "${sample.id}"`, sample.source, []]);
	}
	const { architecture, comparison, guardrail } = profile;
	if (architecture) {
		const texts = architecture.nodes.map((node) => node.detail);
		entries.push(["architecture", architecture.source, texts]);
	}
	for (const row of profile.interfaces ?? []) {
		entries.push([`interface "${row.name}"`, row.source, [row.summary]]);
	}
	for (const row of profile.limits?.rows ?? []) {
		entries.push([`limit "${row.label}"`, row.source, [row.value, row.note]]);
	}
	for (const step of profile.quickstart ?? []) {
		if (step.source) {
			entries.push([`quickstart "${step.title}"`, step.source, []]);
		}
	}
	if (comparison) {
		const texts = comparison.rows.flatMap((row) => row.values);
		entries.push(["comparison", comparison.source, texts]);
	}
	if (guardrail) {
		entries.push(["guardrail", guardrail.source, [guardrail.description]]);
	}
	for (const row of profile.availability ?? []) {
		entries.push([`availability "${row.platform}"`, row.source, [row.note]]);
	}
	for (const item of profile.catalog?.items ?? []) {
		entries.push([`catalog "${item.title}"`, item.source, [item.description]]);
	}
	const status = profile.status;
	for (const item of [
		...(status?.today ?? []),
		...(status?.planned ?? []),
		...(status?.notPlanned ?? []),
		...(profile.security?.points ?? []),
	]) {
		entries.push([`status "${item.text}"`, item.source, [item.text]]);
	}
	if (profile.openapi) {
		entries.push(["openapi", profile.openapi.source, []]);
	}
	return entries;
}

function quotedContentErrors(profile: ProductProfile): string[] {
	const errors: string[] = [];
	for (const sample of profile.code ?? []) {
		if (
			!normalizeWhitespace(sample.code).includes(
				normalizeWhitespace(sample.source.quote)
			)
		) {
			errors.push(`code "${sample.id}": its quote is not in the sample`);
		}
		if (UNPUBLISHED_INSTALL.test(sample.code)) {
			errors.push(`code "${sample.id}": @ryuhq/services* is not on npm`);
		}
	}
	for (const step of profile.quickstart ?? []) {
		if (step.command === undefined) {
			continue;
		}
		if (
			!normalizeWhitespace(step.command).includes(
				normalizeWhitespace(step.source.quote)
			)
		) {
			errors.push(`quickstart "${step.title}": its quote is not the command`);
		}
		if (UNPUBLISHED_INSTALL.test(step.command)) {
			errors.push(`quickstart "${step.title}": @ryuhq/services* is not on npm`);
		}
	}
	return errors;
}

function linkErrors(profile: ProductProfile, root: string): string[] {
	const errors: string[] = [];
	for (const link of profile.docs ?? []) {
		if (!resolveDocsPath(link.path, root)) {
			errors.push(`docs "${link.label}": path does not resolve (${link.path})`);
		}
	}
	for (const link of profile.related ?? []) {
		errors.push(...relatedErrors(link, root));
	}
	for (const slug of profile.compareSlugs ?? []) {
		if (!isFile(join(root, COMPARISONS_DIR, `${slug}.json`))) {
			errors.push(`compare "${slug}": no comparison data`);
		}
	}
	const openapi = profile.openapi;
	if (openapi) {
		if (
			!(
				/^\/openapi\/[\w.-]+\.json$/.test(openapi.href) &&
				isFile(join(root, WEB_PUBLIC_DIR, openapi.href))
			)
		) {
			errors.push(`openapi: no document at ${openapi.href}`);
		}
		const sourceFile = join(root, openapi.source.path);
		if (
			openapi.baseUrl &&
			isFile(sourceFile) &&
			!readFileSync(sourceFile, "utf8").includes(new URL(openapi.baseUrl).host)
		) {
			errors.push(
				`openapi: ${openapi.source.path} does not name ${openapi.baseUrl}`
			);
		}
	}
	return errors;
}

/**
 * Every grounding problem in a profile, empty when it is fully sourced:
 * - each source path exists and each quote is in its file (whitespace normalised);
 * - code samples and quickstart commands contain their quote, and never install
 *   the unpublished `@ryuhq/services*` packages;
 * - docs and related links resolve, compare slugs and OpenAPI documents exist;
 * - no displayed price comes from anywhere but the published pricing table.
 */
export function groundingErrors(
	profile: ProductProfile,
	root = repoRoot()
): string[] {
	const errors: string[] = [];
	for (const [where, source, texts] of sourcedEntries(profile)) {
		errors.push(...sourceErrors(where, source, root));
		errors.push(...priceErrors(where, source, texts));
	}
	errors.push(...quotedContentErrors(profile));
	errors.push(...linkErrors(profile, root));
	return errors;
}
