// Entry point for the Decision Wizard widget bundle. Vite inlines the CSS imports
// (cssCodeSplit off + singlefile) so the emitted `decision-wizard.html` makes zero
// external fetches under the widget CSP. `mountWidget` installs the bridge + openai
// shim and renders the component inside `WidgetRoot` (theme + auto-height wiring).

import "../../shared/tokens.css";
import "./decision-wizard.css";
import { mountWidget } from "../../shared/host";
import { DecisionWizard } from "./DecisionWizard";

mountWidget(<DecisionWizard />);
