// Integrate wiring point for overlay bodies. The registry pre-registers skeleton
// bodies for the "settings" and "gateway" ids so openOverlay() always works; this
// module re-registers those ids with the real bodies (last registration wins).
// App.tsx imports this module for its side effect so the swap happens at boot.

import { gatewayOverlay } from "./gateway/index.tsx";
import { registerOverlay } from "./registry.ts";
import { settingsOverlay } from "./settings/index.tsx";

registerOverlay(settingsOverlay);
registerOverlay(gatewayOverlay);
