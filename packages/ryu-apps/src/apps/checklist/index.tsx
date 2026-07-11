// Checklist widget entry (spec §5.1/§5.2). `index.html` loads this module; it wires
// the shared design tokens + local styles and mounts the component through the shared
// host shell (installs the bridge + openai shim, applies theme, reports height).

import "../../shared/tokens.css";
import "./checklist.css";
import { mountWidget } from "../../shared/host";
import { Checklist } from "./Checklist";

mountWidget(<Checklist />);
