import { describe, expect, test } from "bun:test";
import { localizedTextOf } from "./localizedText.ts";
import { checkDocker, parseDockerInfo } from "./vaultIsolation-docker.ts";
import { DockerUnavailableError } from "./vaultIsolation-host.ts";

describe("isolation docker checks", () => {
	test("docker info is parsed into its flags", () => {
		expect(parseDockerInfo('linux|Ubuntu|["name=rootless"]')).toEqual({
			osType: "linux",
			operatingSystem: "Ubuntu",
			rootless: true,
			userns: false,
		});
	});

	test("refusals are localized sentences", async () => {
		const host = await checkDocker(
			() => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
			"win32"
		).catch((error: unknown) => error);
		expect(host).toBeInstanceOf(DockerUnavailableError);
		expect(localizedTextOf(host as Error)?.source).toBe(
			"Container isolation supports Linux and macOS hosts only (this host is {platform})."
		);
		const windows = await checkDocker(
			() =>
				Promise.resolve({ exitCode: 0, stderr: "", stdout: "windows|W|[]" }),
			"linux"
		).catch((error: unknown) => error);
		expect((windows as Error).message).toBe(
			"Container isolation needs Linux containers, but Docker reports 'windows'. Switch Docker to Linux containers."
		);
	});
});
