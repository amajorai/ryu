import { readFileSync } from "node:fs";
import path from "node:path";
import { mergeConfig, type Plugin, type UserConfig } from "vite";
import audioDevicesProof from "./vite.audio-devices-settings-proof.config.ts";
import dictationProof from "./vite.dictation-settings-proof.config.ts";
import voiceSettingsProof from "./vite.voice-settings-proof.config.ts";

// Serves one of the three existing voice/audio settings proof harnesses
// unchanged, except that Vite's dependency cache lives under a caller-owned
// scratch directory instead of the shared checkout.
const harnesses: Record<string, UserConfig> = {
	"audio-devices": audioDevicesProof,
	dictation: dictationProof,
	"voice-settings": voiceSettingsProof,
};

const harnessName = process.env.RYU_VOICE_AUDIO_COVERAGE_HARNESS ?? "";
const base = harnesses[harnessName];
if (!base) {
	throw new Error(
		`RYU_VOICE_AUDIO_COVERAGE_HARNESS must be one of ${Object.keys(harnesses).join(", ")}`
	);
}
const cacheRoot =
	process.env.RYU_VOICE_AUDIO_COVERAGE_VITE_CACHE ?? "/tmp/voice-audio-pw/vite";

// Opt-in for baseline and mutant runs only: serve a scratch body in place of
// one shipping voice settings component, so no shipping file is edited.
const settingsDir = path.resolve(
	import.meta.dirname,
	"../../src/components/settings"
);
const overrideComponent = process.env.RYU_VOICE_AUDIO_COVERAGE_TARGET;
const overrideFile = process.env.RYU_VOICE_AUDIO_COVERAGE_OVERRIDE;
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
							`[voice-audio-coverage-override] applied=1 ${overrideFile}\n`
						);
						return readFileSync(overrideFile, "utf8");
					},
					name: "voice-audio-coverage-override",
				},
			]
		: [];

export default mergeConfig(base, {
	cacheDir: `${cacheRoot}/${harnessName}`,
	plugins: overridePlugins,
});
