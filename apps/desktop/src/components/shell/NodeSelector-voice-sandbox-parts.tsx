import { useQuery } from "@tanstack/react-query";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	DEFAULT_SPEECH_PROCESSING_PREFS,
	DEFAULT_VOICE_PREFS,
	getSpeechProcessingPrefs,
	getVoiceInputPrefs,
	type SpeechProcessingContext,
	type SpeechProcessingPrefs,
	type SpeechProcessingStructure,
	type SpeechProcessingStyling,
} from "@/src/lib/api/preferences.ts";
import { fetchSandboxBackends } from "@/src/lib/api/sandbox.ts";
import {
	listSpeechProcessingEngines,
	listTtsEngines,
} from "@/src/lib/api/voice.ts";
import { type LayerOption, NodeLayerMenu } from "./NodeLayerMenu.tsx";

/** The voice + sandbox poll behind {@link VoiceAndSandboxSection}: Audio
 *  engines, Voice Recognition and Speech Processing preferences, and sandbox
 *  backends in one request. */
export function useVoiceAndSandboxQuery(target: ApiTarget, enabled: boolean) {
	const query = useQuery({
		queryKey: ["node-voice-sandbox", target.url],
		queryFn: async () => {
			const [
				ttsEngines,
				sttPrefs,
				speechProcessingEngines,
				speechProcessingPrefs,
				sandboxBackends,
			] = await Promise.all([
				listTtsEngines(target).catch(() => []),
				getVoiceInputPrefs(target).catch(() => DEFAULT_VOICE_PREFS),
				listSpeechProcessingEngines(target).catch(() => []),
				getSpeechProcessingPrefs(target).catch(
					() => DEFAULT_SPEECH_PROCESSING_PREFS
				),
				// Absent on an older Core → no sandbox layer rather than a fake one.
				fetchSandboxBackends(target).catch(() => null),
			]);
			return {
				ttsEngines,
				sttPrefs,
				speechProcessingEngines,
				speechProcessingPrefs,
				sandboxBackends,
			};
		},
		enabled,
		refetchInterval: 15_000,
		retry: false,
	});
	return query;
}

const speechStyles: SpeechProcessingStyling[] = [
	"casual",
	"semi-casual",
	"semi-formal",
	"formal",
];
const speechStructures: SpeechProcessingStructure[] = ["prose", "lists"];
const speechContexts: SpeechProcessingContext[] = ["general", "email"];

/** Style / Structure / Context submenus nested inside the Speech Processing
 *  layer once its model is installed. */
export function SpeechProcessingOptionMenus({
	speechProcessingPrefs,
	updateSpeechProcessing,
}: {
	speechProcessingPrefs: SpeechProcessingPrefs;
	updateSpeechProcessing: (
		patch: Partial<SpeechProcessingPrefs>
	) => Promise<void>;
}) {
	return (
		<>
			<NodeLayerMenu
				currentLabel={speechProcessingPrefs.styling}
				installed={speechStyles.map(
					(value): LayerOption => ({
						name: value,
						label: value,
						active: value === speechProcessingPrefs.styling,
						select: () => updateSpeechProcessing({ styling: value }),
					})
				)}
				label="Style"
			/>
			<NodeLayerMenu
				currentLabel={speechProcessingPrefs.structure}
				installed={speechStructures.map(
					(value): LayerOption => ({
						name: value,
						label: value,
						active: value === speechProcessingPrefs.structure,
						select: () => updateSpeechProcessing({ structure: value }),
					})
				)}
				label="Structure"
			/>
			<NodeLayerMenu
				currentLabel={speechProcessingPrefs.context}
				installed={speechContexts.map(
					(value): LayerOption => ({
						name: value,
						label: value,
						active: value === speechProcessingPrefs.context,
						select: () => updateSpeechProcessing({ context: value }),
					})
				)}
				label="Context"
			/>
		</>
	);
}
