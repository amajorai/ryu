import { describe, expect, it } from "bun:test";
import {
	classifyDownloadArch,
	type DownloadArch,
	type DownloadOS,
	findChannelRelease,
	findCoreReleaseAsset,
	findCoreReleaseWithAsset,
	findReleaseAsset,
	findReleaseWithAsset,
	isDesktopAsset,
	isStableRelease,
	loadReleases,
	RELEASES_PAGE,
	type Release,
	resetReleasesCache,
	resolveDownloadState,
	stableReleases,
} from "./download-assets.ts";

describe("classifyDownloadArch", () => {
	it("uses Chromium's explicit Apple-silicon signal over its MacIntel user agent", () => {
		expect(
			classifyDownloadArch(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
				"arm"
			)
		).toBe("arm");
	});

	it("keeps Intel as the fallback when no ARM signal is present", () => {
		expect(classifyDownloadArch("Mozilla/5.0 (X11; Linux x86_64)")).toBe(
			"intel"
		);
	});
});

// Verbatim asset names from the real v0.1.1 release of amajorai/ryu, in the
// order the GitHub API returns them. The ordering matters to the regression:
// `ryu-island-win-x64-setup.exe` sorts BEFORE `Ryu_0.1.1_x64-setup.exe`, so a
// first-match-wins scan that does not exclude the companion apps hands Windows
// visitors the Island installer.
const V011_ASSETS = [
	"latest.json",
	"Ryu-0.1.1-1.x86_64.rpm",
	"Ryu-0.1.1-1.x86_64.rpm.sig",
	"Ryu-aarch64.app.tar.gz",
	"Ryu-aarch64.app.tar.gz.sig",
	"ryu-cli-linux-x86_64",
	"ryu-cli-macos-aarch64",
	"ryu-cli-windows-x86_64.exe",
	"ryu-core-linux-x86_64",
	"ryu-core-macos-aarch64",
	"ryu-core-windows-x86_64.exe",
	"ryu-gateway-linux-x86_64",
	"ryu-gateway-macos-aarch64",
	"ryu-gateway-windows-x86_64.exe",
	"ryu-island-linux-amd64.deb",
	"ryu-island-linux-x86_64.AppImage",
	"ryu-island-mac-arm64.dmg",
	"ryu-island-mac-arm64.zip",
	"ryu-island-win-x64-portable.exe",
	"ryu-island-win-x64-setup.exe",
	"Ryu-x86_64.app.tar.gz",
	"Ryu_0.1.1_aarch64.dmg",
	"Ryu_0.1.1_amd64.AppImage",
	"Ryu_0.1.1_amd64.deb",
	"Ryu_0.1.1_x64-setup.exe",
	"Ryu_0.1.1_x64-setup.exe.sig",
	"Ryu_0.1.1_x64.dmg",
	"Ryu_0.1.1_x64_en-US.msi",
];

const COMBOS: { os: DownloadOS; arch: DownloadArch }[] = [
	{ os: "macos", arch: "arm" },
	{ os: "macos", arch: "intel" },
	{ os: "windows", arch: "arm" },
	{ os: "windows", arch: "intel" },
	{ os: "linux", arch: "arm" },
	{ os: "linux", arch: "intel" },
];

function release(names: string[], overrides: Partial<Release> = {}): Release {
	return {
		id: 1,
		tag_name: "v0.1.1",
		name: "v0.1.1",
		published_at: "2026-08-01T00:00:00Z",
		html_url: "https://github.com/amajorai/ryu/releases/tag/v0.1.1",
		assets: names.map((name) => ({
			name,
			browser_download_url: `https://example.invalid/${name}`,
		})),
		...overrides,
	};
}

/** Deterministic shuffle: proves matching never leans on GitHub's ordering. */
function reversed(names: string[]) {
	return [...names].reverse();
}

describe("isDesktopAsset", () => {
	it("rejects the companion apps and the raw sidecar binaries", () => {
		for (const name of [
			"ryu-island-win-x64-setup.exe",
			"ryu-island-linux-amd64.deb",
			"ryu-island-mac-arm64.dmg",
			"ryu-browser-win-x64-setup.exe",
			"ryu-cli-windows-x86_64.exe",
			"ryu-core-macos-aarch64",
			"ryu-gateway-linux-x86_64",
			"Ryu.Bot_0.3.0_aarch64.dmg",
			"Ryu.Bot_0.3.0_x64-setup.exe",
			"Ryu.Bot_0.3.0_amd64.AppImage",
		]) {
			expect(isDesktopAsset(name)).toBe(false);
		}
	});

	it("keeps the Tauri desktop installers", () => {
		for (const name of [
			"Ryu_0.1.1_x64-setup.exe",
			"Ryu_0.1.1_x64_en-US.msi",
			"Ryu_0.1.1_aarch64.dmg",
			"Ryu_0.1.1_amd64.AppImage",
			"Ryu-0.1.1-1.x86_64.rpm",
			"Ryu.Desktop.Research_Preview.0.1.7_aarch64.dmg",
		]) {
			expect(isDesktopAsset(name)).toBe(true);
		}
	});
});

describe("findReleaseAsset", () => {
	it("gives Windows x64 the desktop installer, not the Island one", () => {
		const asset = findReleaseAsset(release(V011_ASSETS), "windows", "intel");
		expect(asset?.name).toBe("Ryu_0.1.1_x64-setup.exe");
	});

	it("resolves every shipped platform to its desktop installer", () => {
		const rel = release(V011_ASSETS);
		expect(findReleaseAsset(rel, "macos", "arm")?.name).toBe(
			"Ryu_0.1.1_aarch64.dmg"
		);
		expect(findReleaseAsset(rel, "macos", "intel")?.name).toBe(
			"Ryu_0.1.1_x64.dmg"
		);
		expect(findReleaseAsset(rel, "linux", "intel")?.name).toBe(
			"Ryu_0.1.1_amd64.AppImage"
		);
	});

	it("never resolves to a companion or sidecar asset, in any order", () => {
		for (const assets of [V011_ASSETS, reversed(V011_ASSETS)]) {
			const rel = release(assets);
			for (const { os, arch } of COMBOS) {
				const asset = findReleaseAsset(rel, os, arch);
				if (asset) {
					expect(isDesktopAsset(asset.name)).toBe(true);
				}
			}
		}
	});

	it("matches the same assets whatever order GitHub returns them in", () => {
		const forward = release(V011_ASSETS);
		const backward = release(reversed(V011_ASSETS));
		for (const { os, arch } of COMBOS) {
			expect(findReleaseAsset(backward, os, arch)?.name ?? null).toBe(
				findReleaseAsset(forward, os, arch)?.name ?? null
			);
		}
	});

	it("reports the arches we do not ship as absent", () => {
		const rel = release(V011_ASSETS);
		expect(findReleaseAsset(rel, "windows", "arm")).toBeNull();
		expect(findReleaseAsset(rel, "linux", "arm")).toBeNull();
	});
});

describe("findCoreReleaseAsset", () => {
	it("resolves the standalone Core binary instead of a desktop installer", () => {
		const asset = findCoreReleaseAsset(
			release(V011_ASSETS),
			"windows",
			"intel"
		);
		expect(asset?.name).toBe("ryu-core-windows-x86_64.exe");
		expect(asset?.name).not.toMatch(/Ryu_/);
	});

	it("resolves the shipped macOS ARM and Linux Intel Core binaries", () => {
		const rel = release(V011_ASSETS);
		expect(findCoreReleaseAsset(rel, "macos", "arm")?.name).toBe(
			"ryu-core-macos-aarch64"
		);
		expect(findCoreReleaseAsset(rel, "linux", "intel")?.name).toBe(
			"ryu-core-linux-x86_64"
		);
	});

	it("falls back to the last release carrying Core while a new one uploads", () => {
		const found = findCoreReleaseWithAsset(
			[release([], { id: 2, tag_name: "v0.1.2" }), release(V011_ASSETS)],
			"windows",
			"intel"
		);
		expect(found?.release.tag_name).toBe("v0.1.1");
		expect(found?.asset.name).toBe("ryu-core-windows-x86_64.exe");
	});

	it("reports a missing target instead of matching the desktop release", () => {
		expect(
			findCoreReleaseAsset(release(V011_ASSETS), "macos", "intel")
		).toBeNull();
	});
});

describe("findReleaseWithAsset", () => {
	it("falls past a just-tagged release whose binaries are still uploading", () => {
		const building = release([], { id: 2, tag_name: "v0.1.2" });
		const found = findReleaseWithAsset(
			[building, release(V011_ASSETS)],
			"windows",
			"intel"
		);
		expect(found?.release.tag_name).toBe("v0.1.1");
		expect(found?.asset.name).toBe("Ryu_0.1.1_x64-setup.exe");
	});

	it("skips drafts", () => {
		const draft = release(V011_ASSETS, {
			id: 3,
			tag_name: "v0.1.2",
			draft: true,
		});
		const found = findReleaseWithAsset(
			[draft, release(V011_ASSETS)],
			"macos",
			"arm"
		);
		expect(found?.release.tag_name).toBe("v0.1.1");
	});

	it("returns null when no release carries the build", () => {
		expect(
			findReleaseWithAsset([release(V011_ASSETS)], "linux", "arm")
		).toBeNull();
	});
});

describe("resolveDownloadState", () => {
	it("serves the installer and names the version it came from", () => {
		const state = resolveDownloadState(
			[release(V011_ASSETS)],
			"windows",
			"intel"
		);
		expect(state).toMatchObject({
			kind: "ready",
			servedVersion: "v0.1.1",
			supersededByBuilding: false,
		});
		expect(state.kind === "ready" && state.asset.name).toBe(
			"Ryu_0.1.1_x64-setup.exe"
		);
	});

	it("flags that a newer release is still building when it falls back", () => {
		const building = release([], { id: 2, tag_name: "v0.1.2" });
		const state = resolveDownloadState(
			[building, release(V011_ASSETS)],
			"windows",
			"intel"
		);
		expect(state).toMatchObject({
			kind: "ready",
			servedVersion: "v0.1.1",
			supersededByBuilding: true,
		});
	});

	it("says 'building' when the newest release has no desktop assets at all", () => {
		const state = resolveDownloadState(
			[release([], { id: 2, tag_name: "v0.1.2" })],
			"macos",
			"arm"
		);
		expect(state).toEqual({ kind: "building", version: "v0.1.2" });
	});

	it("treats a release carrying only companion assets as still building", () => {
		// The Island publishes on its own workflow, so its files can land before
		// the desktop build finishes. That is a building release, not a shipped one.
		const state = resolveDownloadState(
			[
				release(["ryu-island-win-x64-setup.exe"], {
					id: 2,
					tag_name: "v0.1.2",
				}),
			],
			"windows",
			"intel"
		);
		expect(state).toEqual({ kind: "building", version: "v0.1.2" });
	});

	it("does not call a never-shipped target 'building' during a release window", () => {
		// Windows ARM is absent from every release forever. A freshly tagged
		// release must not flip it to "still building" for a binary never coming.
		const state = resolveDownloadState(
			[release([], { id: 2, tag_name: "v0.1.2" }), release(V011_ASSETS)],
			"windows",
			"arm"
		);
		expect(state).toEqual({ kind: "unavailable" });
	});

	it("says 'unavailable' only when the release shipped without this target", () => {
		expect(
			resolveDownloadState([release(V011_ASSETS)], "linux", "arm")
		).toEqual({ kind: "unavailable" });
	});

	it("never reports unavailable when the release list could not be read", () => {
		// The regression this guards: an empty list is ignorance, not knowledge.
		// Disabling on it leaves the download page with nothing to click.
		expect(resolveDownloadState([], "macos", "arm")).toEqual({
			kind: "unknown",
			href: RELEASES_PAGE,
		});
	});
});

describe("isStableRelease", () => {
	it("drops the rolling nightly and canary tags", () => {
		expect(
			isStableRelease(release([], { tag_name: "nightly", prerelease: true }))
		).toBe(false);
		expect(
			isStableRelease(release([], { tag_name: "canary", prerelease: true }))
		).toBe(false);
	});

	it("drops drafts and keeps stable releases", () => {
		expect(isStableRelease(release([], { draft: true }))).toBe(false);
		expect(isStableRelease(release(V011_ASSETS))).toBe(true);
	});
});

describe("loadReleases", () => {
	it("issues one request however many menus ask for it", async () => {
		resetReleasesCache();
		const original = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = new Proxy(original, {
			apply() {
				calls++;
				return Promise.resolve(
					new Response(JSON.stringify([{ ...release(V011_ASSETS) }]), {
						status: 200,
					})
				);
			},
		});
		try {
			const results = await Promise.all([
				loadReleases(),
				loadReleases(),
				loadReleases(),
			]);
			expect(calls).toBe(1);
			for (const result of results) {
				expect(result).toHaveLength(1);
			}
		} finally {
			globalThis.fetch = original;
			resetReleasesCache();
		}
	});
});

describe("prerelease channels", () => {
	const nightly = release(
		[
			"ryu-island-win-x64-setup.exe",
			"Ryu_0.1.2-nightly.20260803.24_aarch64.dmg",
			"Ryu_0.1.2-nightly.20260803.24_x64-setup.exe",
			"Ryu_0.1.2-nightly.20260803.24_x64.dmg",
		],
		{ id: 9, tag_name: "nightly", prerelease: true }
	);
	const all = [release(V011_ASSETS), nightly];

	it("finds a channel by its fixed rolling tag", () => {
		expect(findChannelRelease(all, "nightly")?.id).toBe(9);
		expect(findChannelRelease(all, "canary")).toBeNull();
	});

	it("keeps the channel out of the stable list", () => {
		expect(stableReleases(all).map((r) => r.tag_name)).toEqual(["v0.1.1"]);
	});

	it("serves the channel's own desktop build, not the Island one", () => {
		expect(findReleaseAsset(nightly, "windows", "intel")?.name).toBe(
			"Ryu_0.1.2-nightly.20260803.24_x64-setup.exe"
		);
	});

	it("reports platforms the channel did not build as absent", () => {
		expect(findReleaseAsset(nightly, "linux", "intel")).toBeNull();
	});
});
