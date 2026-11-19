import { describe, expect, it } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n";
import type { SandboxBackendEntry } from "@/src/hooks/useSandboxBackends.ts";
import { sandboxDescription } from "./EnginesCatalogSection-model.ts";
import { sandboxNotDetected } from "./EnginesCatalogSection-sandbox-copy.ts";

/** A pack that only knows catalogued sentences: anything not routed through
 *  `tl` comes back untranslated and fails the assertions below. */
const tl: LiteralMessage = (source) => `[fr] ${source}`;

function backend(
	name: string,
	overrides: Partial<SandboxBackendEntry> = {}
): SandboxBackendEntry {
	return {
		detected: false,
		displayName: name,
		isDefault: false,
		name,
		supported: true,
		...overrides,
	} as SandboxBackendEntry;
}

describe("sandboxNotDetected", () => {
	it("names the runtime to install inside one translated sentence", () => {
		const docker = sandboxNotDetected(tl, "docker");
		expect(docker).toStartWith("[fr] Not detected.");
		expect(docker).toContain("Docker Desktop or Colima");
		expect(sandboxNotDetected(tl, "microsandbox")).toContain(
			"[fr] Not detected. Ryu does not install microsandbox"
		);
		expect(sandboxNotDetected(tl, "opensandbox")).toContain(
			"the opensandbox CLI"
		);
	});

	it("translates the MXC override and avoids em dashes", () => {
		const mxc = sandboxNotDetected(tl, "mxc");
		expect(mxc).toStartWith("[fr] Not detected. Ryu does not install MXC");
		for (const name of ["docker", "microsandbox", "opensandbox", "mxc"]) {
			expect(sandboxNotDetected(tl, name)).not.toContain("—");
		}
	});

	it("returns null for a backend without install docs", () => {
		expect(sandboxNotDetected(tl, "singularity")).toBeNull();
	});
});

describe("sandboxDescription", () => {
	it("translates every state's sentence", () => {
		expect(sandboxDescription(tl, backend("docker", { detected: true }))).toBe(
			"[fr] Detected on this node and ready to use."
		);
		expect(sandboxDescription(tl, backend("wasmtime"))).toStartWith(
			"[fr] Built-in WASM sandbox"
		);
		const dockerNotDetected = sandboxNotDetected(tl, "docker");
		expect(dockerNotDetected).not.toBeNull();
		expect(sandboxDescription(tl, backend("docker"))).toBe(
			dockerNotDetected ?? ""
		);
		expect(sandboxDescription(tl, backend("singularity"))).toBe(
			"[fr] Not detected. Install its CLI on the node to use it."
		);
	});
});
