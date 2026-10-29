import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

// apps/desktop/src/lib/console-buffer.ts
//
// A tiny in-memory ring buffer that captures console output for the crash screen's
// "Copy console" action (CrashBoundary.tsx) and the developer-mode diagnostics
// bundle. Active in development builds and when the user enables Developer Mode in
// Settings → Developer.
//
// Privacy note: this deliberately mirrors nothing to the network. In production
// builds it is a no-op unless the user explicitly opted into Developer Mode, and
// does not run counter to crash.ts's posture of stripping console content from
// crash reports.

const MAX_ENTRIES = 500;

/** Maximum number of lines the crash screen will place on the clipboard. */
export const MAX_CONSOLE_COPY_LINES = 5000;

type Level = "log" | "info" | "warn" | "error" | "debug";

interface Entry {
	level: Level;
	text: string;
	time: string;
}

const CAPTURED_LEVELS: readonly Level[] = [
	"log",
	"info",
	"warn",
	"error",
	"debug",
];

const buffer: Entry[] = [];
let installed = false;

const serializeArg = <TArg>(arg: TArg): string | undefined => {
	if (isNativeText(arg)) {
		return arg;
	}
	if (arg instanceof Error) {
		return arg.stack ?? `${arg.name}: ${arg.message}`;
	}
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
};

const DEV_MODE_KEY = "ryu_developer_mode";

const shouldCapture = (): boolean =>
	!!import.meta.env.DEV || localStorage.getItem(DEV_MODE_KEY) === "true";

/**
 * Wrap the console methods so their output is recorded into a bounded ring buffer.
 * Idempotent. Active in development builds or when Developer Mode is on. Original
 * console behaviour is preserved — each call still forwards to the native method.
 *
 * The capture gate is checked for each call so turning Developer Mode off stops
 * adding new entries immediately. A later opt-in takes effect without another
 * wrapper: installation remains idempotent for the lifetime of the page.
 */
export const installConsoleCapture = (): void => {
	if (installed || !shouldCapture()) {
		return;
	}
	installed = true;

	for (const level of CAPTURED_LEVELS) {
		const original = console[level].bind(console);
		console[level] = (...args: Parameters<typeof original>): void => {
			if (shouldCapture()) {
				buffer.push({
					level,
					time: new Date().toISOString(),
					text: args.map(serializeArg).join(" "),
				});
				if (buffer.length > MAX_ENTRIES) {
					buffer.shift();
				}
			}
			original(...args);
		};
	}
};

/** Render the captured buffer as plain text, oldest first. Empty string if none. */
export const getConsoleBufferText = (): string =>
	buffer
		.map(
			(entry) => `[${entry.time}] ${entry.level.toUpperCase()} ${entry.text}`
		)
		.join("\n");

/** Keep copied console output useful when one entry expands to many lines. */
export const limitConsoleText = (
	text: string,
	maxLines = MAX_CONSOLE_COPY_LINES
): string => {
	const lineLimit = Math.floor(maxLines);
	if (!text || lineLimit <= 0) {
		return "";
	}

	const lines = text.split("\n");
	if (lines.length <= lineLimit) {
		return text;
	}

	const retainedLineCount = lineLimit - 1;
	const omittedLineCount = lines.length - retainedLineCount;
	const marker = `[... ${omittedLineCount} earlier console lines omitted ...]`;
	return retainedLineCount > 0
		? [marker, ...lines.slice(-retainedLineCount)].join("\n")
		: marker;
};

/** Whether console capture is currently active (dev build or developer mode). */
export const isConsoleCaptureActive = (): boolean => installed;
