import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
// apps/desktop/src/lib/api/safe-mode.ts
//
// Typed client for Core's Safe Mode switch — the OS-style "boot with the whole
// extension layer off" mode. While it is active Core masks every non-kernel
// app/plugin off, skips the SKILL.md injection block, merges no user MCP servers,
// and never spawns the scheduler; chat, agents, auth, updates and settings stay.
//
// Two things about the shape are load-bearing for the UI:
//
//   - `enabled` is the EFFECTIVE state, `preferenceEnabled` is what is stored.
//     They disagree on a node forced on by `RYU_SAFE_MODE`, where `userClearable`
//     is false — bind the switch to the effective flag and you render a control
//     the user cannot move.
//   - the write applies on the NEXT boot (`restartRequired` is always true).
//     Applying live would leave every sidecar, MCP child and scheduler loop that
//     already spawned still running, so the switch would report success while the
//     CPU cost it exists to remove kept being paid.

import { isLocalNode } from "@/src/store/useNodeStore.ts";
import { invokeWhenReady } from "../tauri-ready.ts";
import { ApiError, type ApiTarget, request } from "./client.ts";
import {
	type RawSafeModeState,
	type SafeModeSentinelInput,
	safeModeSentinelSchema,
	safeModeSourceSchema,
	safeModeWireSchema,
} from "./safe-mode-wire-contracts.ts";

/** Which of the three resolution tiers turned Safe Mode on. */
export type SafeModeSource = "off" | "env" | "sentinel" | "preference";

/** What Safe Mode is currently holding back — the numbers that make it a diagnostic. */
export interface SafeModeSuppressed {
	/** Kernel-tier plugins still running (Spaces, RAG, engines, …). */
	kernelPlugins: number;
	/** `mcp.json` entries that a normal boot would spawn as external processes. */
	mcpServers: number;
	/** Installed + user-enabled apps/plugins masked off. */
	plugins: number;
	/** Registered SKILL.md skills not injected into requests. */
	skills: number;
}

export interface SafeModeState {
	/** Effective state for THIS Core process run. */
	enabled: boolean;
	/** The persisted preference, which can disagree with `enabled` under an env force. */
	preferenceEnabled: boolean;
	source: SafeModeSource;
	suppressed: SafeModeSuppressed;
	/** False when `RYU_SAFE_MODE` forces it on — the in-app switch cannot clear that. */
	userClearable: boolean;
}

/**
 * Normalise at the boundary, defaulting every field the UI dereferences. Same
 * defensive convention as the rest of this domain: a missing `suppressed` object
 * would otherwise throw on `state.suppressed.plugins` and take the settings tab
 * down with it — in the one mode a user reaches for when things are already broken.
 */
function toState(raw: RawSafeModeState): SafeModeState {
	const r = raw ?? {};
	const s = r.suppressed ?? {};
	const parsedSource = safeModeSourceSchema.safeParse(r.source);
	const source = parsedSource.success ? parsedSource.data : "off";
	return {
		enabled: r.enabled ?? false,
		preferenceEnabled: r.preference_enabled ?? false,
		source,
		suppressed: {
			kernelPlugins: s.kernel_plugins ?? 0,
			mcpServers: s.mcp_servers ?? 0,
			plugins: s.plugins ?? 0,
			skills: s.skills ?? 0,
		},
		// Absent means "not reported" — treat as clearable so the switch stays
		// usable against an older Core rather than silently locking itself.
		userClearable: r.user_clearable ?? true,
	};
}

/** Read the node's Safe Mode state and what it suppresses. */
export async function fetchSafeMode(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<SafeModeState> {
	return toState(
		safeModeWireSchema.parse(
			await request(
				target,
				"/api/safe-mode",
				{ signal },
				gatewayJsonValueSchema
			)
		)
	);
}

/**
 * Arm or clear Safe Mode for the next boot. Persists both the preference (which
 * fans out to every surface over the preferences stream) and the `~/.ryu/safe-mode`
 * sentinel file, so the next boot is correct even if Core never comes back up.
 *
 * Rejects with Core's 409 when the node is forced on by `RYU_SAFE_MODE`.
 */
export async function setSafeMode(
	target: ApiTarget,
	enabled: boolean,
	signal?: AbortSignal
): Promise<void> {
	await request(
		target,
		"/api/safe-mode",
		{
			body: { enabled },
			method: "PUT",
			signal,
		},
		gatewayJsonValueSchema
	);
}

/**
 * Read the `~/.ryu/safe-mode` sentinel directly, without Core.
 *
 * The whole reason the sentinel tier exists: when Core will not come up there is
 * no HTTP to ask, and the preference lives in a SQLite store that may be the thing
 * that is wedged. Only answers for the sentinel — an env-forced or preference-only
 * node reads false here and true from {@link fetchSafeMode}.
 */
export async function readSafeModeSentinel(): Promise<boolean> {
	try {
		return safeModeSentinelSchema.parse(
			await invokeWhenReady<SafeModeSentinelInput>("get_safe_mode_sentinel")
		);
	} catch {
		// Not running under Tauri (webapp, harness) — no sentinel to speak of.
		return false;
	}
}

/**
 * Arm or clear the sentinel without Core, for the crash/preflight path.
 *
 * Deliberately does not restart anything: the caller owns that, and on the screen
 * this is for the process is usually already down.
 */
export async function writeSafeModeSentinel(enabled: boolean): Promise<void> {
	await invokeWhenReady("set_safe_mode_sentinel", { enabled });
}

/**
 * The one way the UI should change Safe Mode: ask Core, and fall back to the
 * desktop sentinel only when the local Core cannot be reached. Remote failures
 * remain failures: the desktop filesystem cannot represent a remote node.
 *
 * Going straight to the sentinel would be a correctness bug, not just a shortcut.
 * Core persists BOTH tiers, and the preference outlives a sentinel delete — so a
 * user who armed Safe Mode from Settings (preference + sentinel) and then cleared
 * only the sentinel from the preflight page would reboot straight back into Safe
 * Mode with nothing on screen explaining why. Whoever can write both, writes both.
 *
 * Returns how it was applied, so a caller can say something accurate about a node
 * that was not reachable.
 */
export async function applySafeMode(
	target: ApiTarget,
	enabled: boolean,
	signal?: AbortSignal
): Promise<"core" | "sentinel"> {
	try {
		await setSafeMode(target, enabled, signal);
		return "core";
	} catch (e) {
		// An `ApiError` means Core ANSWERED and refused — most importantly the 409
		// for a node forced on by `RYU_SAFE_MODE`, which no sentinel write can
		// override. Falling back there would report success for a flip that cannot
		// happen. Only a transport failure (Core down, wrong URL) earns the
		// sentinel path, which is the case the sentinel exists for.
		if (e instanceof ApiError) {
			throw new Error(e.serverMessage ?? e.message);
		}
		signal?.throwIfAborted();
		if (!isLocalNode(target)) {
			throw e;
		}
		await writeSafeModeSentinel(enabled);
		return "sentinel";
	}
}
