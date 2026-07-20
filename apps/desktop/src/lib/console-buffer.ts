// apps/desktop/src/lib/console-buffer.ts
//
// A tiny in-memory ring buffer that captures console output in DEVELOPMENT ONLY.
// It exists purely to power the dev-only "Copy console" action on the crash screen
// (CrashBoundary.tsx), so a developer can grab recent logs + the crash stack in one
// click instead of scrolling the devtools console.
//
// Privacy note: this deliberately mirrors nothing to the network. It is gated on
// `import.meta.env.DEV`, so it is a no-op in production builds and does not run
// counter to crash.ts's posture of stripping console content from crash reports.

const MAX_ENTRIES = 500;

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

const serializeArg = (arg: unknown): string => {
	if (typeof arg === "string") {
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

/**
 * Wrap the console methods so their output is recorded into a bounded ring buffer.
 * Idempotent and a no-op outside development. Original console behaviour is
 * preserved — each call still forwards to the native method.
 */
export const installConsoleCapture = (): void => {
	if (installed || !import.meta.env.DEV) {
		return;
	}
	installed = true;

	for (const level of CAPTURED_LEVELS) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]): void => {
			buffer.push({
				level,
				time: new Date().toISOString(),
				text: args.map(serializeArg).join(" "),
			});
			if (buffer.length > MAX_ENTRIES) {
				buffer.shift();
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
