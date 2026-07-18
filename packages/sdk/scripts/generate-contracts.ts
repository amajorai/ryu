/**
 * generate:contracts — emit TS types from the Rust-blessed manifest JSON Schema.
 *
 * Reads the checked-in `crates/ryu-kernel-contracts/schemas/plugin-manifest.schema.json`
 * (kept current by that crate's blessed-file test; re-bless with
 * `RYU_REGEN_SCHEMAS=1 cargo test -p ryu-kernel-contracts`) and compiles it to
 * `src/generated/plugin-manifest.ts` with json-schema-to-typescript.
 *
 * The output is checked in and must be regenerated whenever the schema file
 * changes. Deterministic: same schema in → byte-identical file out, so a second
 * run produces no diff.
 *
 * NOTE: this generated shape is Core's authoritative wire model. It does NOT
 * replace the hand-written zod `PluginManifestSchema` in `src/manifest.ts`,
 * which deliberately models the simpler SDK authoring surface.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, type JSONSchema } from "json-schema-to-typescript";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaPath = join(
	packageDir,
	"../../crates/core/kernel-contracts/schemas/plugin-manifest.schema.json"
);
const outPath = join(packageDir, "src/generated/plugin-manifest.ts");

const schema = JSON.parse(await readFile(schemaPath, "utf8")) as JSONSchema;

const banner = [
	"/**",
	" * GENERATED FILE — DO NOT EDIT.",
	" *",
	" * Source of truth: crates/ryu-kernel-contracts (Rust) via the checked-in",
	" * schemas/plugin-manifest.schema.json. Regenerate with:",
	" *",
	" *   bun run generate:contracts",
	" *",
	" * (after re-blessing the schema with",
	" *  `RYU_REGEN_SCHEMAS=1 cargo test -p ryu-kernel-contracts` when the Rust",
	" *  manifest types change).",
	" */",
].join("\n");

const output = await compile(schema, "PluginManifest", {
	additionalProperties: false,
	bannerComment: banner,
	style: { useTabs: true },
});

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, output, "utf8");
process.stdout.write(`wrote ${outPath}\n`);
