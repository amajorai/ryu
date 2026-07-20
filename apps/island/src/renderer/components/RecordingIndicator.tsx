// Re-export shim: the presentational recording indicator now lives in
// @ryu/blocks/island so the storyboard renders the real component. This file is
// kept as the app-local import path used across the island renderer.

export { RecordingIndicator } from "@ryu/blocks/island/recording-indicator";
