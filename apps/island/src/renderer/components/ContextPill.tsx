// Re-export shim: the presentational context pill now lives in
// @ryu/blocks/island. The block's structural `IslandActiveContext` type matches
// this app's `ActiveContext` (appName/degraded/live), so callers pass it
// unchanged.

export { ContextPill } from "@ryu/blocks/island/context-pill";
