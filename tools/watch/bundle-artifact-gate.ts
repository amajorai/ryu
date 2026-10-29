import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { unsafeChangedPath } from "./unsafe-path.ts";

const PUBLIC_BROWSER_KEYS = new Set([
	"VITE_POSTHOG_KEY",
	"NEXT_PUBLIC_POSTHOG_KEY",
	"NEXT_PUBLIC_TURNSTILE_SITE_KEY",
]);

export async function verifyBundleDirectory(
	directory: string,
	environment: Record<string, string | undefined> = process.env
): Promise<void> {
	const root = resolve(directory);
	const rootEntry = await lstat(root);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`${directory} must be a real build directory.`);
	}
	const pending = [root];
	const issues: string[] = [];
	const sensitiveValues = Object.entries(environment).flatMap(
		([key, value]) => {
			if (
				!/(?:^|_)(?:API_)?(?:SECRET|TOKEN|KEY|PASSWORD)(?:$|_)/.test(key) ||
				PUBLIC_BROWSER_KEYS.has(key) ||
				!value ||
				value.length < 16
			) {
				return [];
			}
			return [{ key, forms: [value, JSON.stringify(value).slice(1, -1)] }];
		}
	);
	let files = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) {
			break;
		}
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const path = resolve(current, entry.name);
			const name = relative(root, path);
			if (entry.isSymbolicLink()) {
				issues.push(`${name}: symlink in published bundle`);
			} else if (entry.isDirectory()) {
				pending.push(path);
			} else if (entry.isFile()) {
				files += 1;
				const reason = unsafeChangedPath(name);
				if (reason) {
					issues.push(`${name}: ${reason}`);
				}
				if (
					/\.(?:js|mjs|cjs|css|html|json|txt)$/i.test(name) &&
					sensitiveValues.length > 0
				) {
					const content = await readFile(path);
					for (const { key, forms } of sensitiveValues) {
						if (forms.some((value) => content.includes(value))) {
							issues.push(`${name}: embedded ${key}`);
						}
					}
				}
			} else {
				issues.push(`${name}: unexpected bundle entry`);
			}
			if (issues.length === 100) {
				throw new Error(
					`${directory} contains at least 100 unsafe entries:\n${issues.slice(0, 10).join("\n")}`
				);
			}
		}
	}
	if (files === 0) {
		throw new Error(`${directory} has no published files.`);
	}
	if (issues.length > 0) {
		throw new Error(
			`${directory} contains unsafe artifacts:\n${issues.join("\n")}`
		);
	}
	process.stdout.write(`${directory}: ${files} bundle files checked.\n`);
}

if (import.meta.main) {
	if (process.argv.length < 3) {
		throw new Error("Provide at least one built bundle directory.");
	}
	for (const directory of process.argv.slice(2)) {
		await verifyBundleDirectory(directory);
	}
}
