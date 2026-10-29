import { describe, expect, it } from "bun:test";
import {
	choosePreparedUpdateAction,
	resolveAppUpdateSource,
} from "./app-update-policy.ts";

describe("prepared app update policy", () => {
	it("downloads in advance by default but never chooses installation", () => {
		expect(
			choosePreparedUpdateAction({
				automaticDownload: true,
				latest: "0.2.1",
				preparedVersion: null,
			})
		).toEqual({ kind: "prepare" });
		expect(
			choosePreparedUpdateAction({
				automaticDownload: true,
				latest: "0.2.1",
				preparedVersion: "0.2.1",
			})
		).toEqual({ kind: "prompt_install" });
	});

	it("asks before downloading when automatic downloading is disabled", () => {
		expect(
			choosePreparedUpdateAction({
				automaticDownload: false,
				latest: "0.2.1",
				preparedVersion: null,
			})
		).toEqual({ kind: "notify_download" });
	});

	it("replaces or clears a prepared artifact superseded by a newer verdict", () => {
		expect(
			choosePreparedUpdateAction({
				automaticDownload: true,
				latest: "0.2.2",
				preparedVersion: "0.2.1",
			})
		).toEqual({ kind: "replace" });
		expect(
			choosePreparedUpdateAction({
				automaticDownload: false,
				latest: "0.2.2",
				preparedVersion: "0.2.1",
			})
		).toEqual({ kind: "clear_and_notify" });
	});
});

describe("Tauri updater source policy", () => {
	it("uses only app-owned Stable and release-channel feeds", () => {
		expect(
			resolveAppUpdateSource({
				channel: "stable",
				pin: { kind: "none" },
			})
		).toEqual({ kind: "stable" });
		expect(
			resolveAppUpdateSource({
				channel: "beta",
				pin: { kind: "none" },
			})
		).toEqual({ channel: "beta", kind: "channel" });
	});

	it("reads nightly and canary feeds from the local node's versioned tag", () => {
		expect(
			resolveAppUpdateSource({
				channel: "nightly",
				latest: {
					fromLocalNode: true,
					tag: "v0.4.1-nightly.20260804",
					version: "0.4.1-nightly.20260804",
				},
				pin: { kind: "none" },
			})
		).toEqual({
			channel: "nightly",
			kind: "tag",
			tag: "v0.4.1-nightly.20260804",
		});
		expect(
			resolveAppUpdateSource({
				channel: "canary",
				latest: {
					fromLocalNode: true,
					tag: "v0.4.1-canary.20260804.36",
					version: "0.4.1-canary.20260804.36",
				},
				pin: { kind: "none" },
			})
		).toEqual({
			channel: "canary",
			kind: "tag",
			tag: "v0.4.1-canary.20260804.36",
		});
		expect(
			resolveAppUpdateSource({
				channel: "canary",
				latest: { fromLocalNode: true, tag: null, version: "0.4.1" },
				pin: { kind: "none" },
			})
		).toBeNull();
		expect(
			resolveAppUpdateSource({ channel: "canary", pin: { kind: "none" } })
		).toBeNull();
	});

	it("refuses a nightly or canary tag a remote node or a mismatched verdict chose", () => {
		const canary = (latest: {
			fromLocalNode: boolean;
			tag: string;
			version: string;
		}) =>
			resolveAppUpdateSource({
				channel: "canary",
				latest,
				pin: { kind: "none" },
			});
		// A remote or cloud node must not pick which signed build installs.
		expect(
			canary({
				fromLocalNode: false,
				tag: "v0.4.1-canary.20260804.36",
				version: "0.4.1-canary.20260804.36",
			})
		).toBeNull();
		// The tag must name exactly the advertised version...
		expect(
			canary({
				fromLocalNode: true,
				tag: "v0.4.1-canary.20260801.12",
				version: "0.4.1-canary.20260804.36",
			})
		).toBeNull();
		// ...on the client's own channel, not another train's feed.
		expect(
			canary({
				fromLocalNode: true,
				tag: "v0.4.1-nightly.20260804",
				version: "0.4.1-nightly.20260804",
			})
		).toBeNull();
		expect(
			canary({ fromLocalNode: true, tag: "v0.4.1", version: "0.4.1" })
		).toBeNull();
		// A retired rolling pointer identifies no build.
		expect(
			canary({
				fromLocalNode: true,
				tag: "canary",
				version: "0.4.1-canary.20260804.36",
			})
		).toBeNull();
	});

	it("requires an allowed fixed-channel tag when a release must be pinned", () => {
		expect(
			resolveAppUpdateSource({
				channel: "stable",
				pin: { allowed: true, kind: "required", tag: "v0.2.1" },
			})
		).toEqual({ channel: "stable", kind: "tag", tag: "v0.2.1" });
		expect(
			resolveAppUpdateSource({
				channel: "stable",
				pin: { allowed: false, kind: "required", tag: "v0.2.1" },
			})
		).toBeNull();
		expect(
			resolveAppUpdateSource({
				channel: "canary",
				pin: { allowed: true, kind: "required", tag: "canary" },
			})
		).toBeNull();
	});
});
