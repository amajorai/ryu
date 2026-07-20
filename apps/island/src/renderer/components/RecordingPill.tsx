// Re-export shim: the presentational recording pill now lives in
// @ryu/blocks/island (it keeps the shared @ryu/ui Wave). The live island passes
// the rolling amplitude `levels` + transient `error` from the capture hook.

export {
	RecordingPill,
	type RecordingPillProps,
} from "@ryu/blocks/island/recording-pill";
