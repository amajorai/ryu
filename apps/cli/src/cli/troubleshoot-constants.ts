// Limits, ports, and install commands shared by the `ryu troubleshoot` checks.

export const GIB = 1024 ** 3;
export const DISK_FAIL_BYTES = 1 * GIB;
export const DISK_WARN_BYTES = 5 * GIB;
export const LOCAL_MODEL_RAM_BYTES = 8 * GIB;
export const CORE_TIMEOUT_MS = 5000;
export const GITHUB_TIMEOUT_MS = 8000;
export const LOG_TAIL_BYTES = 256 * 1024;
export const MAX_LOG_LINES = 20;
export const MAX_LOG_LINE_CHARS = 300;
/** Core's release-profile port; profiles add `PROFILE_PORT_OFFSETS`
 *  (crates/core/sidecar-runtime/src/lib.rs). */
export const CORE_BASE_PORT = 7980;
export const PROFILE_PORT_OFFSETS: ReadonlyArray<readonly [string, number]> = [
	["release", 0],
	["dev", 1000],
	["canary", 2000],
	["nightly", 3000],
	["beta", 4000],
];
export const INSTALL_SH =
	"curl -fsSL https://raw.githubusercontent.com/amajorai/ryu/main/install.sh | sh";
export const INSTALL_PS1 =
	"irm https://raw.githubusercontent.com/amajorai/ryu/main/install.ps1 | iex";
export const USAGE =
	'ryu-cli troubleshoot ["what went wrong"] [--fix] [--dry-run] [--open] [--offline] [--json]';
