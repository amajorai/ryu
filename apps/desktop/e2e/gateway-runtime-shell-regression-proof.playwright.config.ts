import { tmpdir } from "node:os";
import base from "./gateway-runtime-controls-proof.playwright.config.ts";

export default {
	...base,
	outputDir: `${tmpdir()}/ryu-gateway-runtime-shell-regression-results`,
	testMatch:
		/(gateway-runtime-controls-proof|gateway-dialog-shell-proof)\.spec\.ts$/,
};
