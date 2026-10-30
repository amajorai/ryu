import type { LiteralMessage } from "@ryu/i18n/react";
import {
	ensureCoreInstalled,
	getRyuStatus,
	startRyuCore,
} from "@/lib/tauri-bridge.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import { fetchCatalog, installSidecar } from "@/src/lib/services-api.ts";
import {
	isLocalNode,
	LOCAL_FALLBACK,
	type Node,
	useNodeStore,
} from "@/src/store/useNodeStore.ts";

// How long the managed path polls the control plane for an already-provisioned
// node before falling back to the web servers page. Kept short: onboarding must
// never block on a live server coming up.
export const ADOPT_MAX_MS = 20 * 1000;

export const ADOPT_POLL_MS = 2000;

export const POLL_INTERVAL_MS = 2000;

// Every Core request onboarding makes carries this. `fetch` has no default
// timeout, so one unanswered request is enough to freeze a whole phase — which
// is exactly how the setup screen used to hang with no way out.
export const REQUEST_TIMEOUT_MS = 15 * 1000;

// How long onboarding will sit on the "installing" screen waiting for the local
// inference stack. A fast (cached) install finishes well inside this and the user
// lands ready. But the install is a sizable model/binary download that can run
// for many minutes — and on macOS it sometimes stays in `installing` for a long
// time — so we never hold the user hostage past this budget: the install keeps
// running in the background and the Models / Getting-Started surfaces track the
// rest. Better to drop them into the app than to freeze the setup screen.
export const MAX_BLOCK_MS = 45 * 1000;

// How long the mic step waits on the OS permission dialog before moving on.
export const MIC_PROMPT_MAX_MS = 30 * 1000;

export const LOCAL_STACK = "llamacpp";

export const sleep = (ms: number) =>
	new Promise<void>((r) => setTimeout(r, ms));

/**
 * Was this failure "you are not authenticated" rather than a transient network
 * blip? Two shapes reach here: the typed {@link ApiError} the node client throws
 * (`status`), and `services-api`'s plain `Error("catalog fetch failed: 401")`.
 * Worth distinguishing because a 401 never heals by retrying with the same
 * credential — it means the token is missing, which on a first run it is.
 */
export function isUnauthorized<TError>(err: TError): boolean {
	if (err instanceof ApiError) {
		return err.status === 401;
	}
	return err instanceof Error && /\b401\b/.test(err.message);
}

/**
 * Re-read the node store from disk and hand back the LOCAL node as it stands
 * right now.
 *
 * Why this exists rather than a plain `nodes.find(isLocalNode)`: Core mints
 * `~/.ryu/secrets/node-auth.token` on its FIRST boot, and the desktop only attaches that
 * token to the local node inside the Tauri `list_nodes` command
 * (`nodes.rs::fill_local_token`) — i.e. at store-load time. On a first run the
 * store hydrates at app boot, long before onboarding's "run locally" pick has
 * started a Core, so the local node it holds carries `token: null`. Every Core
 * call made with that captured object then 401s (`require_auth` rejects a
 * tokenless `/api/*` since the node-token work landed), which silently emptied
 * the agent catalog and made the "Add your agents" step look deleted.
 *
 * So: never capture the local node before Core has booted. Call this after, and
 * again per leg, so a token minted mid-flow is picked up.
 */
export async function refreshLocalNode(): Promise<Node> {
	try {
		await useNodeStore.getState().refresh();
	} catch {
		// Not in Tauri, or the store command failed — fall through to whatever the
		// store already holds rather than failing the whole pick.
	}
	return useNodeStore.getState().nodes.find(isLocalNode) ?? LOCAL_FALLBACK;
}

/**
 * Poll the control plane for a managed (Ryu Cloud) node the active org can
 * already reach, hydrating the node store on each tick. Resolves the first
 * managed node found, or undefined once the budget elapses or the flow is
 * cancelled. This only adopts a node that already exists; it never provisions.
 */
export async function adoptManagedNode(
	hydrate: () => Promise<void>,
	isCancelled: () => boolean
): Promise<Node | undefined> {
	const deadline = Date.now() + ADOPT_MAX_MS;
	while (Date.now() < deadline && !isCancelled()) {
		try {
			await hydrate();
		} catch {
			// Control plane unreachable; keep polling within the budget.
		}
		const managed = useNodeStore.getState().nodes.find((n) => n.managed);
		if (managed) {
			return managed;
		}
		await sleep(ADOPT_POLL_MS);
		if (isCancelled()) {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Poll Core's catalog until the bundled local inference stack finishes (or
 * fails) installing, or the grace budget passes — then let onboarding proceed
 * regardless.
 *
 * On Windows Core auto-triggers the llamacpp install on startup; on macOS that
 * auto-trigger is unreliable, so we kick the install ourselves the first time we
 * see `not_installed` (idempotent: a no-op if Core already started it). Either
 * way we only *block* for `MAX_BLOCK_MS`; the download continues in the
 * background if it's slow, so the user is never stuck on the setup screen.
 */
export async function waitForLocalStack(
	node: { url: string; token: string | null },
	isCancelled: () => boolean,
	report: LocalStatusReporter
): Promise<void> {
	const poll = async () => {
		const deadline = Date.now() + MAX_BLOCK_MS;
		let triggered = false;
		// The credential this loop authenticates with. Mutable because Core may
		// have minted the node token only moments ago (first run): if a poll comes
		// back 401 we re-read it once rather than spending the whole 45s budget on
		// requests that can never succeed — which is what made the local pick look
		// like it stalled and then skipped the agents step.
		let auth = node.token ?? null;
		let reauthed = false;
		while (Date.now() < deadline && !isCancelled()) {
			try {
				const catalog = await fetchCatalog(
					node.url,
					auth,
					AbortSignal.timeout(REQUEST_TIMEOUT_MS)
				);
				const entry = catalog.find((c) => c.name === LOCAL_STACK);
				if (entry?.installState === "installed") {
					report.done("Local AI engine ready");
					report.status(null);
					return;
				}
				if (entry?.installState === "failed") {
					report.status(null);
					return;
				}
				if (entry?.installState === "installing") {
					report.status("Installing the local AI engine…", STAGE_ENGINE);
				}
				// Nothing has started the install (macOS path) — start it once, then
				// keep polling. Best-effort: a failed kick just leaves us polling.
				if (!triggered && entry?.installState === "not_installed") {
					triggered = true;
					report.status("Installing the local AI engine…", STAGE_ENGINE);
					await installSidecar(
						node.url,
						auth,
						LOCAL_STACK,
						false,
						AbortSignal.timeout(REQUEST_TIMEOUT_MS)
					).catch(() => undefined);
				}
			} catch (err) {
				// A 401 is not transient — it means we are holding the wrong (or no)
				// credential, and every remaining poll would fail identically. Re-read
				// the node once; only then fall back to "keep polling".
				if (isUnauthorized(err) && !reauthed) {
					reauthed = true;
					auth = (await refreshLocalNode()).token;
				}
				// Otherwise keep polling on transient network errors.
			}
			await sleep(POLL_INTERVAL_MS);
			if (isCancelled()) {
				return;
			}
		}
	};
	// The `Date.now() < deadline` check only runs BETWEEN iterations, so a single
	// request that never settles used to pin this phase forever — the 45s budget
	// was never enforced. Every request inside now carries its own timeout, and
	// this race is the belt-and-braces: the budget is honoured even if one does
	// not. The install keeps running in the background either way.
	await Promise.race([poll(), sleep(MAX_BLOCK_MS)]);
	// Grace budget elapsed and the stack is still installing — proceed anyway and
	// let it finish in the background rather than stranding the user here.
}

// How long the "run locally" pick waits for a Core it just installed/started to
// answer its health check. Generous because the first run may be downloading the
// binary; past this we surface the failure on the choose step rather than
// dropping the user into an app with no backend.
export const CORE_BOOT_MAX_MS = 5 * 60 * 1000;

export const CORE_BOOT_POLL_MS = 1500;

// After this much of the boot wait, the status admits the wait is long rather
// than repeating "Starting Ryu…" for another four minutes.
export const CORE_BOOT_SLOW_MS = 45 * 1000;

// A typed node address gets one short probe — long enough for a LAN round trip,
// short enough that a wrong address fails fast.
export const CONNECT_PROBE_TIMEOUT_MS = 6000;

/**
 * Bring a local Core up for the "run locally" pick: install the binary if it is
 * missing (a no-op in dev and when it is already there), start it, then poll
 * health until it answers. Resolves true once Core is running.
 *
 * This is the moment the desktop earns the right to install anything. The app
 * itself opens with no Core at all — a user who connects to their team's node
 * never downloads one — so the install is deferred to the explicit local pick
 * rather than run at boot.
 */
export async function startLocalCore(
	isCancelled: () => boolean,
	report: LocalStatusReporter,
	tl: LiteralMessage
): Promise<{ error?: string; ok: boolean }> {
	const onStatus = report.status;
	if ((await getRyuStatus().catch(() => "stopped")) === "running") {
		onStatus(null, null);
		return { ok: true };
	}
	onStatus("Getting Ryu ready…", STAGE_PREPARING);
	// A download failure still leaves an older binary usable, so this is not fatal
	// on its own — but it must not be SWALLOWED either. Both halves used to be
	// `.catch(() => undefined)`, so a 404 on the release asset (or a full disk)
	// bought five silent minutes of polling for a binary that was never on disk,
	// and then a generic "couldn't start" card that named nothing.
	const installError = await ensureCoreInstalled().then(
		() => null,
		(err) => (err instanceof Error ? err.message : String(err))
	);
	if (isCancelled()) {
		return { ok: false };
	}
	const startError = await startRyuCore().then(
		() => null,
		(err) => (err instanceof Error ? err.message : String(err))
	);
	// Nothing to wait for: the install failed AND the spawn found no binary to
	// run. Report the install error (the useful one) immediately instead of
	// burning the whole boot budget.
	if (installError !== null && startError !== null) {
		return { error: installError, ok: false };
	}

	// The download is over but the pick is not: Core still has to boot and answer
	// its health check, which is up to CORE_BOOT_MAX_MS. The installer stops
	// emitting at `done`, so without a status of our own the card would revert to
	// its marketing copy and sit there for five minutes — the same "nothing is
	// happening" shape, just moved past the download.
	const started = Date.now();
	const deadline = started + CORE_BOOT_MAX_MS;
	onStatus("Starting Ryu…", STAGE_BOOTING);
	while (Date.now() < deadline && !isCancelled()) {
		if ((await getRyuStatus().catch(() => "stopped")) === "running") {
			report.done("Ryu is running");
			onStatus(null, null);
			return { ok: true };
		}
		if (Date.now() - started > CORE_BOOT_SLOW_MS) {
			onStatus(
				"Still starting, the first launch takes a little longer…",
				STAGE_BOOTING
			);
		}
		await sleep(CORE_BOOT_POLL_MS);
	}
	onStatus(null, null);
	// Health never answered. `startError` is null on the common shape of this
	// failure (the spawn succeeded, Core died or hung on boot), so say what we
	// actually observed rather than handing the card an empty detail line.
	return {
		error:
			startError ??
			tl(
				"Ryu Core was started but never answered its health check within {minutes} minutes.",
				{ minutes: Math.round(CORE_BOOT_MAX_MS / 60_000) }
			),
		ok: false,
	};
}

/** The stages the installer events cannot see — Core booting, the local engine
 *  install, and agent detection. A fixed position keeps the bar honest across
 *  the whole local setup flow. */
// The stages either side of the installer range have no measurable fraction of
// their own. They bracket the script's structured progress: prepare → install →
// boot → local-stack wait.
export const STAGE_PREPARING = 8;

export const STAGE_BOOTING = 58;

export const STAGE_ENGINE = 70;

export const STAGE_AGENTS = 82;

/** How the async local bring-up talks to the screen: `status` is what is
 *  happening now (null retires the line), `done` records something finished so it
 *  keeps its turn in the rotation afterwards. */
export interface LocalStatusReporter {
	done: (line: string) => void;
	status: (line: string | null, percent?: number | null) => void;
}

/** Normalize a typed node address: trim, add a scheme if omitted, drop the
 *  trailing slash. `192.168.1.20:7980` and `http://192.168.1.20:7980/` both
 *  resolve to the same URL the node store stores. */
export function normalizeNodeUrl(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, "");
	if (trimmed === "") {
		return "";
	}
	return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Probe a node the user just typed. Unlike `test_node` this takes a URL rather
 *  than the name of an already-persisted node — nothing is written to nodes.json
 *  until this passes. */
export async function probeNodeUrl(
	url: string,
	token: string
): Promise<boolean> {
	const headers: RequestInit["headers"] = {};
	if (token !== "") {
		headers.Authorization = `Bearer ${token}`;
	}
	try {
		const res = await fetch(`${url}/api/health`, {
			headers,
			signal: AbortSignal.timeout(CONNECT_PROBE_TIMEOUT_MS),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** A stable, human-readable name for a connected node, derived from its host and
 *  de-duplicated against the names already in the store. */
export function nodeNameForUrl(url: string, taken: readonly string[]): string {
	let base: string;
	try {
		base = new URL(url).hostname || "node";
	} catch {
		base = "node";
	}
	if (!taken.includes(base)) {
		return base;
	}
	let n = 2;
	while (taken.includes(`${base}-${n}`)) {
		n++;
	}
	return `${base}-${n}`;
}
