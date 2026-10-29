/**
 * The truth this figure draws: the JavaScript sandbox that runs agent programs.
 *
 * The figure shows no text. Every fact its hidden description states comes from here,
 * and each is traced to the source. Re-verified against the working tree on 2026-10-22:
 *
 * - QuickJS compiled to WebAssembly and run in-process by Wasmtime:
 *   crates/core/tool-exec/src/js_backend.rs:1-2 (`BACKEND_JS = "quickjs-wasm"` at :80).
 * - Sealed: the guest "can touch nothing the host does not hand it: no filesystem,
 *   network, environment or process table", js_backend.rs:4-6. The WASI context is
 *   built empty (no preopened directories, no environment), js_backend.rs:691.
 *   A permission set that grants files or network is refused outright rather than
 *   run, js_backend.rs:1345-1358 and :1370-1375.
 * - One door: "its only door out is the `ryu` import module", js_backend.rs:6-7.
 *   Every await on the host is an operation of kind tool, sleep or spawn,
 *   js_backend.rs:19-28. The program's result also leaves through that import
 *   (`ryu.done`, js_backend.rs:482-484).
 * - Two keys: `spawn` (`childProcess.run`) is refused unless the manifest granted
 *   `child_process` AND the host named that program in `run_allow`,
 *   js_backend.rs:26-28; enforced at js_backend.rs:1376-1381 (no grant, empty policy)
 *   and :943-946 (name not on the host's list). An empty `run_allow` starts nothing
 *   even with the grant: crates/core/tool-exec/src/lib.rs:499-501.
 * - Memory cap 256 MiB by default: `DEFAULT_MEMORY_MB`, lib.rs:221-223, applied as the
 *   store's memory limit at js_backend.rs:670-676 and :692-693.
 * - Result cap 30,000 bytes: `MAX_PREVIEW_CHARS`, lib.rs:213-216 ("max bytes of
 *   program output"), enforced by `sanitize_tool_value` in
 *   crates/core/tool-exec/src/sanitize.rs:93-101.
 * - Deadline 30 s of active compute: `DEFAULT_DEADLINE_SECS`, lib.rs:218-219.
 *
 * The motion is a simulation of the mechanism (the hatch opens and one call comes out),
 * never a recording of a real run, and it is not timed to one.
 */

/** `DEFAULT_MEMORY_MB`, crates/core/tool-exec/src/lib.rs:223. */
export const MEMORY_MIB = 256;

/** `MAX_PREVIEW_CHARS`, crates/core/tool-exec/src/lib.rs:216 (a byte budget, sanitize.rs:35-38). */
export const RESULT_BYTES = 30_000;

/** `DEFAULT_DEADLINE_SECS`, crates/core/tool-exec/src/lib.rs:219. */
export const DEADLINE_S = 30;

const grouped = (value: number) => value.toLocaleString("en-US");

/** The short name assistive tech hears for the drawing. */
export const LABEL =
	"Ryu's JavaScript sandbox drawn as one sealed box with a single hatch";

/** What the drawing shows, for assistive tech only; nothing here is drawn as text. */
export const DESCRIPTION = `A simulation of the mechanism, not a recording of a real run. Agent programs run in QuickJS compiled to WebAssembly, sealed in a box: the three blanked ports on its roof stand for the filesystem, network and environment the program never gets. The only way in or out is the hatch on the right. A tool call or timer leaves through it and the answer comes back the same way, and the final result comes out cut to ${grouped(RESULT_BYTES)} bytes. Memory is capped at ${MEMORY_MIB} MiB by default and active compute at ${DEADLINE_S} seconds, and starting another program needs both the app's manifest grant and the host's allowlist.`;
