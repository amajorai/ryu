import { defineConfig } from "tsup";

// tsup builds these two configs in parallel, so neither cleans `dist`: a clean
// in one could delete the other's output. `bun run build` cleans once first.
export default defineConfig([
	{
		entry: ["src/index.ts"],
		format: ["esm", "cjs"],
		dts: true,
		shims: true,
	},
	{
		// `npx @ryuhq/client box-tunnel`: the SSH ProxyCommand for Ryu Boxes.
		entry: ["src/box-tunnel.ts"],
		format: ["esm"],
		platform: "node",
	},
]);
