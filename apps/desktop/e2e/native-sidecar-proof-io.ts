/** Native sidecar proof I/O: preserve inherited output and forward upstream bytes. */
export async function runNativeSidecarProofCommand(
	command: string,
	args: string[],
	cwd?: string
) {
	const options: Bun.SpawnOptions.SpawnOptions<"ignore", "inherit", "inherit"> =
		{ stderr: "inherit", stdout: "inherit" };
	if (cwd) {
		options.cwd = cwd;
	}
	const child = Bun.spawn([command, ...args], options);
	const exitCode = await child.exited;
	if (exitCode !== 0) {
		throw new Error(`${command} ${args[0] ?? ""} exited with ${exitCode}.`);
	}
}
export async function forwardNativeSidecarProofRequest(
	request: Request,
	target: string,
	token: string
) {
	const rawBody = ["GET", "HEAD"].includes(request.method)
		? undefined
		: await request.arrayBuffer();
	const options: RequestInit = {
		method: request.method,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
	};
	if (rawBody !== undefined) {
		options.body = rawBody;
	}
	return fetch(target, options);
}
