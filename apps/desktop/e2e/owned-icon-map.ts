import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The installed-individual-icons harness plugin refuses to start without
// caller-owned icon map and diagnostic paths. Callers that pin their own map
// (the appearance proof runners) set RYU_APPEARANCE_ICON_MAP and
// RYU_APPEARANCE_ICON_DIAGNOSTIC; otherwise a fresh map is generated from the
// installed icon packages into this run's own temporary directory. Both are
// written back to process.env so the webServer and workers inherit them.
export function ensureOwnedIconMap(): void {
	if (
		process.env.RYU_APPEARANCE_ICON_MAP &&
		process.env.RYU_APPEARANCE_ICON_DIAGNOSTIC
	) {
		return;
	}
	const iconDir = mkdtempSync(path.join(tmpdir(), "ryu-owned-icons-"));
	process.env.RYU_APPEARANCE_ICON_DIAGNOSTIC ??= path.join(
		iconDir,
		"installed-icons-diagnostic.json"
	);
	if (!process.env.RYU_APPEARANCE_ICON_MAP) {
		const iconMap = path.join(iconDir, "installed-icon-map.json");
		const desktop = path.resolve(import.meta.dirname, "..");
		execFileSync(process.execPath, [
			path.resolve(desktop, "../../tools/generate-installed-icon-map.mjs"),
			desktop,
			iconMap,
		]);
		process.env.RYU_APPEARANCE_ICON_MAP = iconMap;
	}
}

// An absolute, run-owned directory for a harness that requires one: the env
// value when the caller set it, otherwise a fresh temp dir, written back so
// the webServer and workers see the same path.
export function ensureOwnedDir(name: string, prefix: string): string {
	const existing = process.env[name];
	if (existing) {
		return existing;
	}
	const created = mkdtempSync(path.join(tmpdir(), prefix));
	process.env[name] = created;
	return created;
}
