import { readFileSync } from "node:fs";
import path from "node:path";
import { mergeConfig, type Plugin, type UserConfig } from "vite";
import clipsDestinationProof from "./vite.clips-quick-attach-destination-proof.config.ts";
import clipsSettingsProof from "./vite.clips-quick-attach-settings-proof.config.ts";
import meetingsDiarizationProof from "./vite.meetings-diarization-proof.config.ts";
import meetingsSettingsProof from "./vite.meetings-settings-proof.config.ts";
import questsSettingsProof from "./vite.quests-settings-proof.config.ts";

// Serves one of the existing Clips, Quests and Meetings settings proof
// harnesses unchanged, except that Vite's dependency cache lives under a
// caller-owned scratch directory instead of the shared checkout.
const harnesses: Record<string, UserConfig> = {
	"clips-destination": clipsDestinationProof,
	"clips-settings": clipsSettingsProof,
	"meetings-diarization": meetingsDiarizationProof,
	"meetings-settings": meetingsSettingsProof,
	"quests-settings": questsSettingsProof,
};

const harnessName = process.env.RYU_CAPTURE_MEETINGS_HARNESS ?? "";
const base = harnesses[harnessName];
if (!base) {
	throw new Error(
		`RYU_CAPTURE_MEETINGS_HARNESS must be one of ${Object.keys(harnesses).join(", ")}`
	);
}
const cacheRoot =
	process.env.RYU_CAPTURE_MEETINGS_VITE_CACHE ??
	"/tmp/capture-meetings-pw/vite";

// Opt-in for mutant runs only: serve a scratch body in place of one shipping
// settings component, so no shipping file is edited.
const settingsDir = path.resolve(
	import.meta.dirname,
	"../../src/components/settings"
);
const overrideComponent = process.env.RYU_CAPTURE_MEETINGS_TARGET;
const overrideFile = process.env.RYU_CAPTURE_MEETINGS_OVERRIDE;
const overrideTarget = overrideComponent
	? path.resolve(settingsDir, overrideComponent)
	: null;
const overridePlugins: Plugin[] =
	overrideFile && overrideTarget
		? [
				{
					enforce: "pre",
					load(id) {
						if (id.split("?")[0] !== overrideTarget) {
							return null;
						}
						process.stderr.write(
							`[capture-meetings-override] applied=1 ${overrideFile}\n`
						);
						return readFileSync(overrideFile, "utf8");
					},
					name: "capture-meetings-override",
				},
			]
		: [];

export default mergeConfig(base, {
	cacheDir: `${cacheRoot}/${harnessName}`,
	plugins: overridePlugins,
});
