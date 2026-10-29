// apps/cli/src/cli/access.ts
//
// Which one-shot commands skip the Core waitlist access gate. `services`
// delegates to `ryu-services`, which talks to each standalone service with
// that service's own key and never reaches a Core node, so the gate (a Core
// /api/auth/status check) must not block it.

import { findCommand } from "./commands.ts";
import { parseArgs } from "./dispatch.ts";

/** One-shot commands that run without waitlist access. */
export const ACCESS_FREE_COMMANDS: ReadonlySet<string> = new Set([
	"account",
	"help",
	"init",
	"login",
	"logout",
	"node",
	"package",
	"services",
	// A broken install can break sign-in too; diagnosing it must never need it.
	"troubleshoot",
	"bug-report",
	"version",
]);

/** Whether `args` names a command that needs approved waitlist access. */
export function requiresWaitlistAccess(args: string[]): boolean {
	const { command } = parseArgs(args);
	if (command === null) {
		return false;
	}
	// Resolve aliases (`pkg`, `bug-report`) to the canonical command so an
	// exemption cannot depend on which spelling the caller typed.
	const canonical = findCommand(command)?.name ?? command;
	return !ACCESS_FREE_COMMANDS.has(canonical);
}
