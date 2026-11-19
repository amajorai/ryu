import type { LiteralMessage } from "@ryu/i18n/react";

/** The not-detected sentence for a sandbox backend Ryu links to but never
 *  installs, as one whole catalogued sentence per backend so a language pack
 *  translates the runtime name with the rest of the line. `null` means the
 *  backend has no install docs and the caller keeps its generic copy.
 *
 *  The container runtimes need elevated privileges on every platform. MXC
 *  needs no admin setup, and an installed wxc-exec still reads as not detected
 *  when this Windows build is unsupported or the only isolation tier left needs
 *  host permission edits the operator has not allowed. */
export function sandboxNotDetected(
	tl: LiteralMessage,
	name: string
): string | null {
	switch (name) {
		case "docker":
			return tl(
				"Not detected. Ryu does not install Docker because it needs elevated privileges on every platform, so install Docker Desktop or Colima yourself and it is picked up automatically."
			);
		case "microsandbox":
			return tl(
				"Not detected. Ryu does not install microsandbox because it needs elevated privileges on every platform, so install the microsandbox CLI yourself and it is picked up automatically."
			);
		case "opensandbox":
			return tl(
				"Not detected. Ryu does not install OpenSandbox because it needs elevated privileges on every platform, so install the opensandbox CLI yourself and it is picked up automatically."
			);
		case "mxc":
			return tl(
				"Not detected. Ryu does not install MXC, and installing it needs no administrator rights: put wxc-exec on PATH or point RYU_SANDBOX_MXC_BINARY at it. If wxc-exec is already installed, this Windows build may be unsupported, or MXC may need RYU_SANDBOX_MXC_ALLOW_DACL_MUTATION=1 to edit host file permissions for each run."
			);
		default:
			return null;
	}
}
