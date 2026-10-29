import { tmpdir } from "node:os";
import base from "./gateway-dialog-shell-proof.playwright.config.ts";
export default {
	...base,
	use: { ...base.use, navigationTimeout: 120_000 },
	outputDir: `${tmpdir()}/ryu-gateway-runtime-controls-results`,
	testMatch: /gateway-runtime-controls-proof\.spec\.ts$/,
};
