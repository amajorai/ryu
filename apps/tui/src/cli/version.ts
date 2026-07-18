// The `ryu` CLI version, read from the package manifest (resolveJsonModule is on),
// so `ryu version` / `ryu --version` never drifts from package.json.

import pkg from "../../package.json";

export const VERSION: string = pkg.version;
