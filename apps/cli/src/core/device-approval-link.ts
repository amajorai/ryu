/**
 * The approval link with the CLI surface declared.
 *
 * The CLI has no device flow of its own: Core runs the grant, which the
 * server would otherwise count against the self-hosted device limit. The
 * approval page sends `surface=cli` with the approval so the new session
 * counts as a CLI device. This mirrors `DEVICE_SURFACE_QUERY_PARAM` in
 * `@ryu/auth/lib/device-limits`, which the CLI does not depend on. A link
 * that does not parse is returned unchanged (sign-in still works and counts
 * as self-hosted).
 */
const DEVICE_SURFACE_QUERY_PARAM = "surface";

export function declareCliSurface(link: string): string {
	let url: URL;
	try {
		url = new URL(link);
	} catch {
		return link;
	}
	url.searchParams.set(DEVICE_SURFACE_QUERY_PARAM, "cli");
	return url.toString();
}
