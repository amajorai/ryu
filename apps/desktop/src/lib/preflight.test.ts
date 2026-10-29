import { beforeEach, describe, expect, mock, test } from "bun:test";

let enabled = true;
let configured = true;
let receipt: string | null = "event-123";
const capture = mock(<TFixture>(_error: TFixture) => receipt);
const analytics = mock(() => undefined);
const clipboard = mock(async (_text: string) => undefined);
mock.module("@tauri-apps/api/app", () => ({ getVersion: async () => "1.0.0" }));
mock.module("@/src/lib/analytics.ts", () => ({ track: analytics }));
mock.module("@/src/lib/crash.ts", () => ({
	crashReportingReady: async () => true,
	isCrashReportingConfigured: () => configured,
	isCrashReportingEnabled: () => enabled,
	reportError: capture,
}));
mock.module("@/src/lib/api/system.ts", () => ({
	fetchHealth: async () => ({ version: "1.0.0" }),
	fetchSystemStatus: async () => ({ gatewayReachable: true }),
}));
mock.module("@/src/lib/api/update.ts", () => ({
	getVersionInfo: async () => ({}),
}));
mock.module("@/src/lib/console-buffer.ts", () => ({
	getConsoleBufferText: () => "private console text",
}));
mock.module("@/src/lib/dev-metrics.ts", () => ({
	getDevMetricsText: () => "",
}));
mock.module("@/src/lib/services-api.ts", () => ({
	fetchCatalog: async () => [],
}));

Object.defineProperty(globalThis, "navigator", {
	configurable: true,
	value: {
		platform: "test",
		userAgent: "test",
		clipboard: { writeText: clipboard },
	},
});
const { copyDiagnostics, reportIssue } = await import("./preflight.ts");
const target = { url: "http://localhost:7980", token: null, userJwt: null };

beforeEach(() => {
	enabled = true;
	configured = true;
	receipt = "event-123";
	capture.mockClear();
	analytics.mockClear();
	clipboard.mockReset();
	clipboard.mockImplementation(async () => undefined);
});

describe("preflight action receipts", () => {
	test("a denied clipboard write rejects instead of reporting success", async () => {
		clipboard.mockImplementation(async () => {
			throw new Error("Clipboard permission denied");
		});
		await expect(copyDiagnostics(target)).rejects.toThrow(
			"Clipboard permission denied"
		);
	});
	test("successful copy contains the locally collected diagnostics", async () => {
		const text = await copyDiagnostics(target);
		expect(clipboard).toHaveBeenCalledWith(text);
		expect(text).toContain("private console text");
	});
	test("disabled reporting does not collect or submit a report", async () => {
		enabled = false;
		await expect(reportIssue(target)).rejects.toThrow("Crash reporting is off");
		expect(capture).not.toHaveBeenCalled();
		expect(analytics).not.toHaveBeenCalled();
	});
	test("an unconfigured reporting destination is visibly unavailable", async () => {
		configured = false;
		await expect(reportIssue(target)).rejects.toThrow(
			"unavailable in this build"
		);
		expect(capture).not.toHaveBeenCalled();
	});
	test("a missing queue receipt rejects and does not record success", async () => {
		receipt = null;
		await expect(reportIssue(target)).rejects.toThrow("could not be queued");
		expect(analytics).not.toHaveBeenCalled();
	});
	test("a queue receipt records the action without including console contents", async () => {
		await reportIssue(target);
		expect(capture).toHaveBeenCalledTimes(1);
		const error = capture.mock.calls[0]?.[0];
		expect(error).toBeInstanceOf(Error);
		if (error instanceof Error) {
			expect(error.message).not.toContain("private console text");
			expect(error.message).toContain("[preflight-report]");
		}
		expect(analytics).toHaveBeenCalledWith({
			event: "error_shown",
			code: "preflight_report",
		});
	});
});
