const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;
const LINE_SUFFIX_RE = /:\d+(?::\d+)?$/;

function normalize(path: string): string {
	return path.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
}

/** Resolve an agent-authored file mention without letting `..` escape the project. */
export function resolveWorkspaceFilePath(
	folder: string | null | undefined,
	mentionedPath: string
): string | null {
	if (!folder) {
		return null;
	}
	const root = normalize(folder).replace(/\/$/, "");
	const raw = normalize(mentionedPath.trim()).replace(LINE_SUFFIX_RE, "");
	if (!raw) {
		return null;
	}
	const absolute = raw.startsWith("/") || WINDOWS_ABSOLUTE_RE.test(raw);
	if (absolute) {
		if (raw === root) {
			return raw;
		}
		if (!raw.startsWith(`${root}/`)) {
			return null;
		}
		// The prefix alone is not containment: `<root>/../../etc/x` passes it.
		const rest = raw.slice(root.length + 1).split("/");
		return rest.some((part) => part === ".." || part === ".") ? null : raw;
	}
	const parts = raw.replace(/^\.\//, "").split("/");
	if (parts.some((part) => part === ".." || part === "")) {
		return null;
	}
	return `${root}/${parts.join("/")}`;
}
