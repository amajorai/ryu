// The manifest half of a toolsmith package: where a tool body is seated, whether
// the seat is wired so the tool is actually callable, and whether what the
// manifest carries is what the cases tested.
//
// Split out of the CLI on purpose. These checks have to run in BOTH places — in
// `index.mjs verify` (the interactive gate) and inside `defineToolTests` (the
// automated suite) — and a check that exists in only one of them is worse than no
// check: `test:plugins` would go green on a body that had been edited but never
// resealed, i.e. certify code that is not what ships.
//
// Every function here returns problems rather than exiting, so the CLI can print
// them and `node:test` can assert on them.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Canonicalize source text without changing its code or whitespace semantics.
 * Working-tree checkouts may expose CRLF while generated manifest wire strings
 * use LF; line terminators are the only transport detail normalized here.
 */
export function normalizeLineEndings(value) {
	return value.replace(/\r\n?/g, "\n");
}

/**
 * Find the manifest entry that carries this tool's body.
 *
 * Returns `{ manifest, manifestPath, seat }`, where `seat` is `null` when the
 * manifest does not declare the tool at all — a body nothing references is a body
 * that never runs, so callers treat that as a failure rather than a skip.
 *
 * Throws when there is no manifest to read; that is a broken package, not a
 * finding.
 */
export function findManifestSeat(dir, spec, kind) {
	const manifestPath = join(dir, "manifest.json");
	if (!existsSync(manifestPath)) {
		throw new Error(`${dir} has no manifest.json`);
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

	if (kind === "adapter") {
		for (const entry of manifest.provides ?? []) {
			const binding = entry.tools?.[spec.tool];
			if (binding) {
				return { manifest, manifestPath, seat: { type: "adapter", binding } };
			}
		}
		return { manifest, manifestPath, seat: null };
	}

	if (kind === "turn_hook") {
		// A hook is seated by id in `contributes.turn_hooks`, not by slug — so for
		// this kind `cases.json`'s `tool` field carries the hook id.
		for (const hook of manifest.contributes?.turn_hooks ?? []) {
			if (hook.id === spec.tool) {
				return { manifest, manifestPath, seat: { type: "turn_hook", hook } };
			}
		}
		return { manifest, manifestPath, seat: null };
	}

	for (const runnable of manifest.runnables ?? []) {
		if (runnable.kind === "tool" && runnable.config?.slug === spec.tool) {
			return {
				manifest,
				manifestPath,
				seat: { type: "inline_js", config: runnable.config },
			};
		}
	}
	return { manifest, manifestPath, seat: null };
}

/**
 * Does the manifest carry exactly the body the cases tested?
 *
 * For an `inline_js` tool the manifest's `code` string is the ONLY form Core
 * loads, and it is sealed from the authored file by `toolsmith sync`. Nothing
 * else notices when the two diverge — the file is what gets reviewed and tested,
 * the string is what gets executed.
 *
 * For an adapter there is nothing to seal: Core hydrates `code_file` from the
 * plugin's own directory. The equivalent failure is a manifest pointing at a
 * different file than the cases test, or one that has been "simplified" back to
 * an inline `code`.
 */
export function checkBodyDrift(seat, spec, code) {
	const problems = [];

	// Both file-backed forms: `code_file` is the loadable form, so the check is
	// that the manifest points at the file the cases test and has not been
	// "simplified" back to an inline `code`.
	const fileBacked =
		seat.type === "adapter"
			? { label: "adapter", holder: seat.binding.adapter }
			: seat.type === "turn_hook"
				? { label: "turn hook", holder: seat.hook }
				: null;

	if (fileBacked) {
		const declared = fileBacked.holder?.code_file;
		if (declared !== spec.code_file) {
			problems.push(
				`manifest ${fileBacked.label} for '${spec.tool}' points at ${declared ?? "(nothing)"} but cases.json tests ${spec.code_file}`
			);
		}
		if (fileBacked.holder?.code !== undefined) {
			problems.push(
				`manifest ${fileBacked.label} for '${spec.tool}' inlines \`code\` — packaged manifests must use \`code_file\` (see AGENTS.md)`
			);
		}
		return problems;
	}

	if (normalizeLineEndings(seat.config.code) !== normalizeLineEndings(code)) {
		problems.push(
			`manifest \`code\` for '${spec.tool}' has drifted from ${spec.code_file}. The file is the source form — run \`node tools/toolsmith/index.mjs sync <dir>\` to reseal.`
		);
	}
	return problems;
}

/**
 * Mirrors `validate_code_file_path` in `crates/core/kernel-contracts/src/manifest.rs`
 * and `isValidCodeFilePath` in `packages/sdk/src/cli/code-file-contracts.ts`.
 */
const CODE_FILE_PATH =
	/^(?:hooks|adapters)\/(?!\.)(?!.*\.\.)[A-Za-z0-9._-]*\.m?js$/;

/**
 * Mirrors `is_inline_js_backend` in `crates/core/kernel-contracts/src/schema.rs`:
 * the current backend name plus its deprecated pre-rename alias.
 */
const INLINE_JS_BACKENDS = new Set(["inline_js", "inline_deno"]);

/**
 * Mirror, in JS, the load-time rules Core applies to the tool seat — the subset a
 * generated tool can plausibly get wrong.
 *
 * Not a reimplementation of `PluginManifest::validate`: that lives in Rust and is
 * authoritative. This is the fast feedback loop for the handful of rules whose
 * violation produces a *silent* failure rather than a load error — chiefly the
 * missing `tool:execute` grant, which lets an `inline_js` tool register, appear
 * in discovery, and then refuse every call it receives.
 */
export function checkManifestContract(manifest, spec, kind, seat) {
	const problems = [];

	if (!/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/.test(manifest.id ?? "")) {
		problems.push(
			`id '${manifest.id}' is not a scoped plugin id (@scope/name) — every id in this repo is scoped`
		);
	}
	if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(manifest.version ?? "")) {
		problems.push(`version '${manifest.version}' is not semver`);
	}
	if (
		!manifest.description ||
		String.prototype.startsWith.call(manifest.description, "TODO")
	) {
		problems.push(
			"description is missing or still the TODO placeholder — it is what the model routes on"
		);
	}

	if (kind === "adapter" && seat?.type === "adapter" && spec.adapter_tools) {
		// The harness enforces `adapter_tools` as the callNamed allowlist; it must be
		// the manifest's own list, or a case could pass against a call Core refuses.
		const declared = [...(seat.binding.adapter?.tools ?? [])].sort();
		const tested = [...spec.adapter_tools].sort();
		if (JSON.stringify(declared) !== JSON.stringify(tested)) {
			problems.push(
				`cases adapter_tools [${tested.join(", ")}] differ from the manifest's adapter.tools [${declared.join(", ")}] for '${spec.tool}'`
			);
		}
	}

	if (kind === "adapter" || kind === "turn_hook") {
		// `validate_code_file_path` (and the SDK's `isValidCodeFilePath`): exactly
		// `<hooks|adapters>/<name>.{js,mjs}`, flat, file name from `A-Za-z0-9._-`,
		// no leading `.` and no `..` anywhere (so `adapters/a..js` is rejected).
		if (!CODE_FILE_PATH.test(spec.code_file ?? "")) {
			problems.push(
				`code_file '${spec.code_file}' is not '<hooks|adapters>/<name>.js' — Core rejects anything else at load`
			);
		}
		// An adapter is shipped code exactly like an inline_js body: without the
		// grant the provider still appears in the layer picker, and Core refuses
		// every verb call it routes through the adapter.
		if (
			kind === "adapter" &&
			!(manifest.permission_grants ?? []).includes("tool:execute")
		) {
			problems.push(
				"manifest does not grant 'tool:execute' — Core lists the provider and then refuses every call through its adapter (GRANT_TOOL_EXECUTE)"
			);
		}
		return problems;
	}

	const config = seat.config;
	// `inline_deno` is the deprecated pre-rename spelling of the same backend.
	// Core still loads it (as `inline_js`), so an older package still verifies.
	if (!INLINE_JS_BACKENDS.has(String(config.backend ?? "").trim())) {
		problems.push(
			`runnable for '${spec.tool}' has backend '${config.backend}', expected 'inline_js'`
		);
	}
	if (
		!config.description ||
		String.prototype.startsWith.call(config.description, "TODO")
	) {
		problems.push(
			`tool '${spec.tool}' has no real description — the model picks tools by description, so a TODO makes it unroutable`
		);
	}
	if (!config.input_schema) {
		problems.push(
			`tool '${spec.tool}' declares no input_schema — the model would have to guess the arguments`
		);
	}
	if (!(manifest.permission_grants ?? []).includes("tool:execute")) {
		problems.push(
			"manifest does not grant 'tool:execute' — Core registers the tool and then refuses every call (GRANT_TOOL_EXECUTE)"
		);
	}
	return problems;
}
