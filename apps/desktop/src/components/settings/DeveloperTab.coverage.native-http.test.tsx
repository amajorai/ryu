import { expect, test } from "bun:test";
import {
	act,
	base,
	button,
	calls,
	captionFor,
	clipboard,
	DEV_MODE_KEY,
	errorToast,
	failWipeWrites,
	getConsoleBufferText,
	getHttpSamples,
	getVersionInfo,
	idle,
	installConsoleCapture,
	isConsoleCaptureActive,
	isDevMetricsEnabled,
	markWipeUnsupported,
	maybeButton,
	mount,
	nativeCalls,
	pressSpace,
	refuseWipeEnable,
	registerDeveloperTabHooks,
	requireSwitch,
	select,
	successToast,
	switchById,
	text,
	toolbarCount,
	unmountAll,
	until,
	wipeFile,
} from "./DeveloperTab.coverage.test-support.ts";

// Cases for the shipping Developer tab against its owned native HTTP peer; the
// peer, the IPC bridge and the per-case closure checks live in the support file.
registerDeveloperTabHooks();

test("Enable developer mode persists on this device, reveals the debug rows, starts console capture and metric recording without a reload, and every consumer and a remount read the same choice", async () => {
	expect(isConsoleCaptureActive()).toBe(false);
	localStorage.removeItem(DEV_MODE_KEY);
	await mount(true);
	const devSwitch = requireSwitch("developer-mode");
	expect(devSwitch.getAttribute("aria-checked")).toBe("false");
	expect(text()).toContain("reader:off");
	for (const hidden of [
		"Toolbar active",
		"Console buffer status",
		"Collect & copy diagnostics",
		"Copy console output",
	]) {
		expect(text()).not.toContain(hidden);
	}
	expect(
		switchById("agentation-toolbar")?.getAttribute("role") ?? null
	).toBeNull();
	console.info("developer coverage before opt-in");
	await getVersionInfo({ url: `${base}/a`, token: "developer-a-token" });
	expect(getHttpSamples()).toHaveLength(0);

	// Keyboard operation: the focused switch flips with Space.
	await pressSpace(devSwitch);
	await idle();
	expect(document.activeElement === requireSwitch("developer-mode")).toBe(true);
	expect(requireSwitch("developer-mode").getAttribute("aria-checked")).toBe(
		"true"
	);
	expect(localStorage.getItem(DEV_MODE_KEY)).toBe("true");
	expect(text()).toContain("reader:on");
	// Toolbar active: an always-on indicator while Developer Mode is on.
	const toolbar = requireSwitch("agentation-toolbar");
	expect(toolbar.getAttribute("aria-checked")).toBe("true");
	expect(toolbar.getAttribute("aria-disabled")).toBe("true");
	await act(async () => toolbar.click());
	expect(toolbar.getAttribute("aria-checked")).toBe("true");
	expect(localStorage.getItem(DEV_MODE_KEY)).toBe("true");
	// Console buffer status: capture is installed by the flip itself.
	expect(isConsoleCaptureActive()).toBe(true);
	const capture = requireSwitch("console-capture");
	expect(capture.getAttribute("aria-checked")).toBe("true");
	expect(capture.getAttribute("aria-disabled")).toBe("true");
	expect(captionFor("Console buffer status")).toBe(
		"Capturing. Up to 500 entries are kept in memory."
	);
	// Copy console output on an empty buffer reports it instead of copying.
	await act(async () => button("Copy console").click());
	expect(errorToast).toHaveBeenCalledWith("Console buffer is empty");
	expect(clipboard.writes).toBe(0);
	// Metrics start without a reload: the gate was refreshed by the flip.
	expect(isDevMetricsEnabled()).toBe(true);
	await act(async () => {
		await getVersionInfo({ url: `${base}/a`, token: "developer-a-token" });
	});
	expect(getHttpSamples().map((sample) => sample.path)).toEqual([
		"/api/version",
	]);
	console.info("developer coverage after opt-in");
	expect(getConsoleBufferText()).toContain("developer coverage after opt-in");
	expect(getConsoleBufferText()).not.toContain(
		"developer coverage before opt-in"
	);

	// Turning it off hides every gated row at once and stops both recorders.
	await act(async () => requireSwitch("developer-mode").click());
	await idle();
	expect(localStorage.getItem(DEV_MODE_KEY)).toBe("false");
	expect(text()).toContain("reader:off");
	expect(
		switchById("agentation-toolbar")?.getAttribute("role") ?? null
	).toBeNull();
	expect(
		switchById("console-capture")?.getAttribute("role") ?? null
	).toBeNull();
	expect(maybeButton("Copy diagnostics")?.textContent).toBeUndefined();
	expect(isDevMetricsEnabled()).toBe(false);
	console.info("developer coverage after opt-out");
	await act(async () => {
		await getVersionInfo({ url: `${base}/a`, token: "developer-a-token" });
	});
	expect(getHttpSamples()).toHaveLength(1);
	expect(getConsoleBufferText()).not.toContain(
		"developer coverage after opt-out"
	);

	// An independent remount reads the stored choice.
	await unmountAll();
	await mount();
	expect(requireSwitch("developer-mode").getAttribute("aria-checked")).toBe(
		"false"
	);
	await act(async () => requireSwitch("developer-mode").click());
	await unmountAll();
	await mount();
	expect(requireSwitch("developer-mode").getAttribute("aria-checked")).toBe(
		"true"
	);
	expect(requireSwitch("agentation-toolbar").getAttribute("aria-checked")).toBe(
		"true"
	);
});

test("Copy console output places the captured lines on the clipboard and reports a clipboard failure without copying", async () => {
	localStorage.setItem(DEV_MODE_KEY, "true");
	// Boot installs capture when Developer Mode was left on (main.tsx).
	installConsoleCapture();
	await mount();
	console.warn("developer coverage warning line");
	clipboard.fail = true;
	await act(async () => button("Copy console").click());
	expect(errorToast).toHaveBeenCalledWith("Couldn't copy to clipboard");
	expect(clipboard.text).toBe("");
	clipboard.fail = false;
	await act(async () => button("Copy console").click());
	expect(successToast).toHaveBeenCalledWith(
		"Console output copied to clipboard"
	);
	expect(clipboard.text).toMatch(/WARN developer coverage warning line/);
	expect(clipboard.text).toBe(getConsoleBufferText());
});

test("Collect & copy diagnostics bundles the selected node's probes with that node's authority, reports a clipboard failure, and follows a node switch", async () => {
	localStorage.setItem(DEV_MODE_KEY, "true");
	installConsoleCapture();
	await mount();
	console.info("developer coverage diagnostics marker");
	await act(async () => button("Copy diagnostics").click());
	await until(
		() => successToast.mock.calls.length === 1,
		"Diagnostics were not copied"
	);
	expect(successToast).toHaveBeenCalledWith("Diagnostics copied to clipboard");
	const bundle = clipboard.text;
	expect(bundle).toStartWith("# Ryu diagnostics");
	expect(bundle).toContain(`node ${base}/a`);
	expect(bundle).toContain("## Desktop\nversion 3.2.1-coverage");
	expect(bundle).toContain('"version": "7.4.1-coverage-a"');
	expect(bundle).toContain('"ryu_version": "7.4.1-coverage-a"');
	expect(bundle).toContain('"platform": "coverage-a"');
	expect(bundle).toContain('"parse-a": true');
	expect(bundle).toContain(
		"## Sidecars (/api/catalog)\n(unavailable: catalog fetch failed: 503)"
	);
	expect(bundle).toContain("developer coverage diagnostics marker");
	expect(bundle).toContain("## Performance");
	// Health is the anonymous probe; the rest carry node A's own token.
	const forA = calls.filter((call) => call.owner === "a");
	expect(
		forA.find((call) => call.path === "/api/health")?.authorization
	).toBeNull();
	expect(forA.find((call) => call.path === "/api/version")?.authorization).toBe(
		"Bearer developer-a-token"
	);

	clipboard.fail = true;
	await act(async () => button("Copy diagnostics").click());
	await until(
		() => errorToast.mock.calls.length === 1,
		"Clipboard failure was not reported"
	);
	expect(errorToast).toHaveBeenCalledWith("Couldn't copy diagnostics");
	expect(clipboard.text).toBe(bundle);

	clipboard.fail = false;
	await select("b");
	calls.length = 0;
	await act(async () => button("Copy diagnostics").click());
	await until(
		() => successToast.mock.calls.length === 2,
		"Diagnostics after the node switch were not copied"
	);
	expect(clipboard.text).toContain(`node ${base}/b`);
	expect(clipboard.text).toContain('"version": "7.4.1-coverage-b"');
	expect(clipboard.text).toContain('"ryu_version": "7.4.1-coverage-b"');
	expect(clipboard.text).not.toContain("7.4.1-coverage-a");
	expect(calls.every((call) => call.owner === "b")).toBe(true);
});

test("Wipe this data folder at midnight is saved through the native command, survives a remount, stays reachable with Developer Mode off, and is hidden where the build has no isolated folder", async () => {
	localStorage.setItem(DEV_MODE_KEY, "false");
	await mount();
	await until(
		() => switchById("midnight-wipe") !== null,
		"Daily reset row did not render"
	);
	expect(text()).toContain("Daily data reset");
	expect(captionFor("Wipe this data folder at midnight")).toContain(
		"Deletes everything in /Users/coverage/.ryu-canary"
	);
	expect(captionFor("Wipe this data folder at midnight")).toContain(
		"Last cleared 2026-10-10."
	);
	const wipe = requireSwitch("midnight-wipe");
	expect(wipe.getAttribute("aria-checked")).toBe("false");
	await act(async () => wipe.click());
	await until(
		() => successToast.mock.calls.length === 1,
		"Enabling the daily reset did not report"
	);
	expect(successToast).toHaveBeenCalledWith(
		"Daily reset on. This build's data folder clears at the first launch after midnight"
	);
	expect(nativeCalls("set_midnight_wipe").map((entry) => entry.args)).toEqual([
		{ enabled: true },
	]);
	expect(wipeFile.enabled).toBe(true);
	expect(requireSwitch("midnight-wipe").getAttribute("aria-checked")).toBe(
		"true"
	);

	await unmountAll();
	await mount();
	await until(
		() => switchById("midnight-wipe")?.getAttribute("aria-checked") === "true",
		"Remount did not read the stored daily reset"
	);
	await act(async () => requireSwitch("midnight-wipe").click());
	await until(
		() => successToast.mock.calls.length === 2,
		"Disabling the daily reset did not report"
	);
	expect(successToast).toHaveBeenLastCalledWith("Daily reset off");
	expect(wipeFile.enabled).toBe(false);

	markWipeUnsupported();
	await unmountAll();
	await mount();
	await idle();
	expect(nativeCalls("get_midnight_wipe").length).toBeGreaterThanOrEqual(3);
	expect(switchById("midnight-wipe")?.getAttribute("role") ?? null).toBeNull();
	expect(text()).not.toContain("Daily data reset");
	expect(localStorage.getItem(DEV_MODE_KEY)).toBe("false");
});

test("Couldn't save that setting: a refused enable keeps the switch off, a failed write shows the command's reason and rereads the stored flag, and the next good write clears it", async () => {
	await mount();
	await until(
		() => switchById("midnight-wipe") !== null,
		"Daily reset row did not render"
	);
	refuseWipeEnable(true);
	await act(async () => requireSwitch("midnight-wipe").click());
	await until(
		() => errorToast.mock.calls.length === 1,
		"Refused enable did not report"
	);
	expect(errorToast).toHaveBeenCalledWith("Couldn't save that setting");
	expect(requireSwitch("midnight-wipe").getAttribute("aria-checked")).toBe(
		"false"
	);
	expect(wipeFile.enabled).toBe(false);
	// A refusal is not an error: the command answered, so no reason row.
	expect(captionFor("Couldn't save that setting")).toBe("");

	refuseWipeEnable(false);
	failWipeWrites("wipe state file is read-only");
	const readsBefore = nativeCalls("get_midnight_wipe").length;
	await act(async () => requireSwitch("midnight-wipe").click());
	await until(
		() => errorToast.mock.calls.length === 2,
		"Failed write did not report"
	);
	expect(captionFor("Couldn't save that setting")).toBe(
		"wipe state file is read-only"
	);
	expect(nativeCalls("get_midnight_wipe").length).toBe(readsBefore + 1);
	expect(requireSwitch("midnight-wipe").getAttribute("aria-checked")).toBe(
		"false"
	);
	expect(successToast).not.toHaveBeenCalled();

	failWipeWrites(null);
	await act(async () => requireSwitch("midnight-wipe").click());
	await until(
		() => successToast.mock.calls.length === 1,
		"Recovered write did not report"
	);
	expect(requireSwitch("midnight-wipe").getAttribute("aria-checked")).toBe(
		"true"
	);
	expect(text()).not.toContain("wipe state file is read-only");
	expect(
		[...document.body.querySelectorAll('[data-slot="item-title"]')].some(
			(element) => element.textContent === "Couldn't save that setting"
		)
	).toBe(false);
	expect(wipeFile.enabled).toBe(true);
});

// Last on purpose: the toolbar logs its own connection warnings into the
// page-lifetime console buffer that the cases above read.
test("Toolbar active describes the annotation toolbar the shell mounts: it appears with Developer Mode, cannot be switched off on its own, and leaves with Developer Mode", async () => {
	localStorage.setItem(DEV_MODE_KEY, "false");
	await mount(false, true);
	await idle();
	expect(toolbarCount()).toBe(0);
	expect(text()).not.toContain("Toolbar active");
	await act(async () => requireSwitch("developer-mode").click());
	await until(
		() => toolbarCount() === 1,
		"The annotation toolbar did not mount with Developer Mode on"
	);
	const indicator = requireSwitch("agentation-toolbar");
	expect(indicator.getAttribute("aria-checked")).toBe("true");
	await act(async () => indicator.click());
	await idle();
	expect(indicator.getAttribute("aria-checked")).toBe("true");
	await pressSpace(indicator);
	await idle();
	expect(indicator.getAttribute("aria-checked")).toBe("true");
	expect(toolbarCount()).toBe(1);
	await act(async () => requireSwitch("developer-mode").click());
	await until(
		() => toolbarCount() === 0,
		"The annotation toolbar outlived Developer Mode"
	);
	expect(
		switchById("agentation-toolbar")?.getAttribute("role") ?? null
	).toBeNull();
	expect(localStorage.getItem(DEV_MODE_KEY)).toBe("false");
});
