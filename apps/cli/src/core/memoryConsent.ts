import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { type CliStateEnvironment, cliStatePath } from "./cliStatePath.ts";

const memoryConsentSchema = z.object({
	version: z.literal(1),
	enableLongTerm: z.boolean(),
});

/** CLI-host consent, separate from Desktop local storage. Malformed data fails closed. */
export function memoryConsentPath(
	environment: CliStateEnvironment = process.env
): string {
	return cliStatePath("cli-memory.json", environment);
}
export function readMemoryConsent(path = memoryConsentPath()): boolean {
	try {
		const parsed = memoryConsentSchema.safeParse(
			JSON.parse(readFileSync(path, "utf8"))
		);
		return parsed.success && parsed.data.enableLongTerm;
	} catch {
		return false;
	}
}
export function writeMemoryConsent(
	enabled: boolean,
	path = memoryConsentPath()
): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(
		temporary,
		JSON.stringify({ version: 1, enableLongTerm: enabled }),
		{ mode: 0o600 }
	);
	renameSync(temporary, path);
	if (readMemoryConsent(path) !== enabled) {
		throw new Error("CLI memory consent was not confirmed.");
	}
}
