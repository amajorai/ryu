// Entry for the Gateway Budget Dial widget. Imports the shared token layer and this
// app's local styles (Vite inlines both into the single-file bundle), then mounts
// the component through the shared host shell (installs the bridge + openai shim,
// applies theme, reports intrinsic height).

import "../../shared/tokens.css";
import "./styles.css";
import { mountWidget } from "../../shared/host";
import { BudgetDial } from "./BudgetDial";

mountWidget(<BudgetDial />);
