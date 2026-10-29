import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The Sentry SDK is imported only after initCrashReporting(), at idle. Reports
// made meanwhile wait in a small queue that the opt-out clears. `crash.ts`
// reads the DSN when first evaluated, so this suite runs in its own process.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register({ url: "http://localhost/" });
}
process.env.VITE_SENTRY_DSN = "https://key@example.invalid/1";
localStorage.clear();

interface InitOptions {
	beforeBreadcrumb: () => unknown;
	beforeSend: (event: Record<string, unknown>) => unknown;
	integrations: (defaults: { name: string }[]) => { name: string }[];
	sendDefaultPii: boolean;
	tracesSampleRate: number;
}

const initOptions: InitOptions[] = [];
const exceptions: unknown[] = [];
const messages: [string, Record<string, unknown>][] = [];
mock.module("@sentry/react", () => ({
	captureException: (error: unknown) => {
		exceptions.push(error);
		return `event-${exceptions.length}`;
	},
	captureMessage: (message: string, context: Record<string, unknown>) => {
		messages.push([message, context]);
		return "message";
	},
	init: (options: InitOptions) => {
		initOptions.push(options);
	},
}));

const {
	crashReportingReady,
	initCrashReporting,
	reportCrashEvent,
	reportError,
	setCrashReportingEnabled,
} = await import("./crash.ts");

function raiseWindowError(error: Error): void {
	window.dispatchEvent(
		Object.assign(new Event("error"), { error, message: error.message })
	);
}

function raiseUnhandledRejection(reason: unknown): void {
	window.dispatchEvent(
		Object.assign(new Event("unhandledrejection"), { reason })
	);
}

test("reports wait for the lazily loaded SDK, and the opt-out drops them", async () => {
	const dropped = new Error("dropped");
	const kept = new Error("kept");

	// Before initCrashReporting(): no client, nothing queued.
	expect(reportError(new Error("early"))).toBeNull();
	expect(await crashReportingReady()).toBe(false);

	initCrashReporting();
	expect(reportError(dropped)).toBeNull();
	raiseWindowError(new Error("dropped early"));
	setCrashReportingEnabled(false);
	// Opted out, early window errors are not even queued.
	raiseUnhandledRejection(new Error("off early"));
	setCrashReportingEnabled(true);
	expect(reportError(kept)).toBeNull();
	// Uncaught errors before the SDK has loaded (a window started hidden) wait
	// in the same queue instead of being lost.
	const earlyError = new Error("early window error");
	const earlyRejection = new Error("early rejection");
	raiseWindowError(earlyError);
	raiseUnhandledRejection(earlyRejection);
	reportCrashEvent("recovered", { tags: { outcome: "remount" } });
	expect(initOptions).toHaveLength(0);

	expect(await crashReportingReady()).toBe(true);
	expect(exceptions).toEqual([kept, earlyError, earlyRejection]);
	// Sentry's own handlers take over: the early listeners are gone.
	raiseWindowError(new Error("after load"));
	expect(exceptions).toHaveLength(3);
	expect(messages).toEqual([
		[
			"recovered",
			{ extra: undefined, level: "info", tags: { outcome: "remount" } },
		],
	]);

	// The privacy posture is unchanged, minus the crumb-recording integration.
	const [options] = initOptions;
	expect(options?.sendDefaultPii).toBe(false);
	expect(options?.tracesSampleRate).toBe(0);
	expect(options?.beforeBreadcrumb()).toBeNull();
	expect(
		options
			?.integrations([{ name: "Breadcrumbs" }, { name: "GlobalHandlers" }])
			.map((integration) => integration.name)
	).toEqual(["GlobalHandlers"]);

	// Once live, a report returns its receipt; opting out stops egress.
	expect(reportError(new Error("live"))).toBe("event-4");
	setCrashReportingEnabled(false);
	expect(reportError(new Error("off"))).toBeNull();
	expect(options?.beforeSend({ message: "off" })).toBeNull();
	expect(exceptions).toHaveLength(4);
});
