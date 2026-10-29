// Capability adapter for `computer.control / computer.scroll`, run in Core's plugin sandbox.
// Injected globals: `input` (canonical verb args), `defaults` (the provider's
// resolved arg_defaults), `callTool(args)` (the manifest-fixed provider tool) and
// `callNamed(id, args)` (one of the extra tools `adapter.tools` declared).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (crates/core/tool-exec `build_capability_adapter_program`) and it `return`s the
// canonical result. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/adapters is excluded from Biome — a module parser rejects it.

// bytebotd's ScrollActionDto nests the optional point as `coordinates: {x, y}`,
// and validates BOTH members as numbers once the object is present. The
// declarative template grammar would send `coordinates: {}` when the optional
// canonical x/y are absent, so the point is attached only when both are whole
// numbers; otherwise the daemon scrolls at the pointer's current position.
const args = { direction: input.direction };
if (Number.isInteger(input.x) && Number.isInteger(input.y)) {
	args.coordinates = { x: input.x, y: input.y };
}
// `scrollCount` counts mouse-wheel ticks with a 150ms sleep between each, so an
// `amount` meant as pixels would wedge the desktop. Clamp to 1..10 ticks; an
// absent or non-integer amount keeps the tool's own default of 3.
if (Number.isInteger(input.amount)) {
	args.scrollCount = Math.min(10, Math.max(1, input.amount));
}
const res = await callTool(args);
return { raw: res };
