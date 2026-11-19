// What container isolation tells people: refusals and status lines as whole
// localized sentences. A refusal keeps its English text in `.message` (what
// `--json` and logs carry) and renders in the CLI locale for people.
// Developer invariants and Docker's own output stay as they are.

import {
	LocalizedError,
	type LocalizedText,
	localize,
	localizedTextOf,
} from "./localizedText.ts";

/** A caught reason as localized text when it carries one, else its message. */
export function reasonOf(error: unknown): LocalizedText | string {
	if (error instanceof Error) {
		return localizedTextOf(error) ?? error.message;
	}
	return String(error);
}

export const isolationText = {
	dockerMissing: () =>
		localize(
			"Container isolation needs Docker, but the `docker` command was not found on PATH."
		),
	unsupportedHost: (platform: string) =>
		localize(
			"Container isolation supports Linux and macOS hosts only (this host is {platform}).",
			{ platform }
		),
	daemonUnreachable: (detail: string) =>
		localize(
			"The Docker daemon is not reachable: {detail}\nStart Docker (or Docker Desktop) and try again.",
			{ detail }
		),
	notLinuxContainers: (osType: string) =>
		localize(
			"Container isolation needs Linux containers, but Docker reports '{osType}'. Switch Docker to Linux containers.",
			{ osType }
		),
	remoteDaemon: (endpoint: string) =>
		localize(
			"Container isolation needs a Docker daemon on this machine, but the docker CLI talks to {endpoint}. Switch to a local context (unix:// socket).",
			{ endpoint }
		),
	rootless: () =>
		localize(
			"Container isolation does not support rootless Docker: its bridge networks live in a separate network namespace, so the host relay cannot reach them. Use a rootful Docker daemon."
		),
	usernsRemap: () =>
		localize(
			"Container isolation does not support a Docker daemon with userns-remap: the command could not use your files in /workspace. Use a daemon without user-namespace remapping."
		),
	invalidImage: (ref: string) =>
		localize("--image {ref} is not a valid image reference.", { ref }),
	pullFailed: (ref: string, output: string) =>
		localize("Could not pull {ref}:\n{output}", { ref, output }),
	destinationNotAbsolute: (destination: string) =>
		localize("--mount destination {destination} must be an absolute path.", {
			destination,
		}),
	destinationNotNormalized: (destination: string) =>
		localize(
			"--mount destination {destination} must be a normalized path without '..' or a trailing '/'.",
			{ destination }
		),
	reservedDestination: (reserved: string) =>
		localize(
			"--mount: refusing to mount over the reserved container path {reserved}.",
			{ reserved }
		),
	hostRoot: () => localize("refusing to mount the host root filesystem."),
	runtimeDirectory: (path: string) =>
		localize(
			"refusing to mount {path}: it can expose a container runtime socket.",
			{ path }
		),
	runtimeSocket: (path: string, socket: string) =>
		localize(
			"refusing to mount {path}: it exposes the container runtime socket {socket}.",
			{ path, socket }
		),
	unixSocket: (path: string) =>
		localize("refusing to mount the Unix socket {path}.", { path }),
	dataDirectoryOverlap: (path: string, dir: string) =>
		localize(
			"refusing to mount {path}: it overlaps the Ryu data directory {dir}.",
			{ path, dir }
		),
	insideDataDirectory: (path: string) =>
		localize("refusing to mount {path}: it is inside a Ryu data directory.", {
			path,
		}),
	mountShape: (raw: string) =>
		localize("--mount {raw}: expected SRC:DST[:ro|rw].", { raw }),
	mountMode: (raw: string) =>
		localize("--mount {raw}: the mode must be 'ro' or 'rw'.", { raw }),
	mountSourceNotAbsolute: (raw: string) =>
		localize("--mount {raw}: the source must be an absolute path.", { raw }),
	mountSourceMissing: (raw: string) =>
		localize("--mount {raw}: the source does not exist.", { raw }),
	mountSourceColon: (raw: string) =>
		localize("--mount {raw}: the resolved source contains ':'.", { raw }),
	mountRefused: (raw: string, reason: LocalizedText | string) =>
		localize("--mount {raw}: {reason}", { raw, reason }),
	workDir: (reason: string) =>
		localize("working directory: {reason}", { reason }),
	workDirColon: () => localize("the working directory path contains ':'."),
	relayDesktop: () =>
		localize(
			"The isolated container could not reach the relay on this host's loopback interface through Docker Desktop's host-gateway."
		),
	relayFirewall: (address: string, subnet: string) =>
		localize(
			"The isolated container could not reach the relay at {address}. A host firewall must let containers on {subnet} reach that address.",
			{ address, subnet }
		),
	runningAsRoot: () =>
		localize("ryu: running as root; the container command runs as uid 65534."),
	running: (command: string, network: string) =>
		localize(
			"ryu: running {command} in an isolated container ({network}); network access only through the credential broker.",
			{ command, network }
		),
};

/** An isolation refusal with localized copy. */
export function isolationError(text: LocalizedText): LocalizedError {
	return new LocalizedError(text);
}
