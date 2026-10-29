export function parseEnvironmentPaste(
	source: string
): { key: string; value: string }[] {
	const entries: { key: string; value: string }[] = [];
	for (const line of source.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
			trimmed
		);
		if (!match) {
			throw new Error("Use KEY=value on each line");
		}
		const key = match[1];
		if (
			/^(RYU_|LD_|DYLD_)/i.test(key) ||
			[
				"PATH",
				"HOME",
				"USER",
				"SHELL",
				"NODE_OPTIONS",
				"BASH_ENV",
				"ENV",
				"COMSPEC",
				"SYSTEMROOT",
				"WINDIR",
				"PYTHONPATH",
				"PYTHONHOME",
			].includes(key.toUpperCase())
		) {
			throw new Error(`Reserved variable: ${key}`);
		}
		if (entries.some((entry) => entry.key === key)) {
			throw new Error(`Duplicate variable: ${key}`);
		}
		let value = match[2];
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		entries.push({ key, value });
		if (entries.length > 100) {
			throw new Error("Import up to 100 variables at a time");
		}
	}
	return entries;
}
