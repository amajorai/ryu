// The loopback URL of this machine's Core for the current profile. Shared by the
// env resolver (target.ts) and the synthesized `local` node (nodes.ts), so a
// missing node registry and an unset RYU_CORE_URL land on the same port.
//
// Profile-aware: under RYU_PROFILE=dev (the repo's `bun dev` default) Core binds
// :8980 (+1000 offset, matching apps/core/src/profile.rs); release stays :7980.
const ryuProfile = (process.env.RYU_PROFILE ?? "").trim().toLowerCase();
export const DEFAULT_CORE_URL =
	ryuProfile && ryuProfile !== "release"
		? "http://127.0.0.1:8980"
		: "http://127.0.0.1:7980";
