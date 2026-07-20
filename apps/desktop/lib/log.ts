/**
 * Dual-sink logger: writes to both the DevTools console and the Tauri log
 * file (via tauri-plugin-log) so diagnostics survive even if the DevTools
 * panel isn't visible or a second process is involved.
 *
 * Usage:  import { log } from "@/lib/log";
 *         log.info("[OAuth] listener registered");
 *         log.error("[OAuth] callback failed:", err);
 */

type LogFn = (...args: unknown[]) => void;

async function tauriLog(
	level: "trace" | "debug" | "info" | "warn" | "error",
	message: string
): Promise<void> {
	try {
		const { trace, debug, info, warn, error } = await import(
			"@tauri-apps/plugin-log"
		);
		const fn_ = { trace, debug, info, warn, error }[level];
		await fn_(message);
	} catch {
		// not in Tauri context — ignore
	}
}

function serialize(...args: unknown[]): string {
	return args
		.map((a) => {
			if (a instanceof Error) {
				return `${a.message}\n${a.stack ?? ""}`;
			}
			if (typeof a === "object") {
				return JSON.stringify(a);
			}
			return String(a);
		})
		.join(" ");
}

function makeLogger(
	level: "trace" | "debug" | "info" | "warn" | "error",
	consoleFn: LogFn
): LogFn {
	return (...args: unknown[]) => {
		consoleFn(...args);
		tauriLog(level, serialize(...args)).catch(() => undefined);
	};
}

export const log = {
	trace: makeLogger("trace", console.debug),
	debug: makeLogger("debug", console.debug),
	info: makeLogger("info", console.log),
	warn: makeLogger("warn", console.warn),
	error: makeLogger("error", console.error),
};
