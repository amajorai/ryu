// Why an agent config cannot be edited safely. Each refusal is a whole
// localized sentence: `.message` stays English (what `--json` carries), and
// human output renders it in the CLI locale. Split from `agentConnect.ts`.

import { LocalizedError, localize } from "./localizedText.ts";

/** Thrown when a config exists but cannot be edited safely (comments in JSON,
 *  an inline TOML entry, a non-object server map). The command then falls back
 *  to printing the snippet for the user to paste. */
export class UnsupportedConfigError extends LocalizedError {}

export function notPlainJson(label: string): UnsupportedConfigError {
	return new UnsupportedConfigError(
		localize(
			"{label} is not plain JSON (it may contain comments), so it cannot be edited safely.",
			{ label }
		)
	);
}

export function notJsonObject(label: string): UnsupportedConfigError {
	return new UnsupportedConfigError(
		localize("{label} must be a JSON object.", { label })
	);
}

export function containerNotObject(
	label: string,
	containerKey: string
): UnsupportedConfigError {
	return new UnsupportedConfigError(
		localize(
			'{label}: "{containerKey}" is not an object, so it cannot be edited safely.',
			{ label, containerKey }
		)
	);
}

export function invalidToml(
	label: string,
	error: string
): UnsupportedConfigError {
	return new UnsupportedConfigError(
		localize(
			"{label} is not valid TOML ({error}), so it cannot be edited safely.",
			{ label, error }
		)
	);
}

export function notTomlTable(label: string): UnsupportedConfigError {
	return new UnsupportedConfigError(
		localize("{label} is not a TOML table.", { label })
	);
}

export function serversAtRoot(
	label: string,
	server: string
): UnsupportedConfigError {
	return new UnsupportedConfigError(
		localize(
			"{label} defines mcp_servers with a root key, which a [mcp_servers.{server}] table cannot extend.",
			{ label, server }
		)
	);
}

export function inlineNotReplaceable(
	label: string,
	server: string
): UnsupportedConfigError {
	return new UnsupportedConfigError(
		localize(
			"{label} defines mcp_servers.{server} inline, so it cannot be replaced safely.",
			{ label, server }
		)
	);
}

export function inlineNotRemovable(
	label: string,
	server: string
): UnsupportedConfigError {
	return new UnsupportedConfigError(
		localize(
			"{label} defines mcp_servers.{server} inline, so it cannot be removed safely.",
			{ label, server }
		)
	);
}

export function sideEffectLayout(label: string): UnsupportedConfigError {
	return new UnsupportedConfigError(
		localize("{label} has a layout Ryu cannot edit without side effects.", {
			label,
		})
	);
}

export function notRegularFile(path: string): UnsupportedConfigError {
	return new UnsupportedConfigError(
		localize("{path} is not a regular file.", { path })
	);
}

export function notUtf8(path: string): UnsupportedConfigError {
	return new UnsupportedConfigError(
		localize("{path} is not valid UTF-8, so it cannot be edited safely.", {
			path,
		})
	);
}

export function symlinkLoop(path: string): UnsupportedConfigError {
	return new UnsupportedConfigError(
		localize("{path} is a symlink loop.", { path })
	);
}
