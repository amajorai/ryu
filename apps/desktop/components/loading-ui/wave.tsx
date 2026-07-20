// Re-export of the shared loading-ui Wave (now in `@ryu/ui` so the island
// companion shares the exact same waveform for voice input). Kept as a local
// path so existing desktop imports (`@/components/loading-ui/wave`) keep working.

export { Wave } from "@ryu/ui/components/wave";
