// Smart Intake Form widget entry (spec §5.2). Imports the shared design tokens and
// this app's local styles (both inlined into the single-file bundle by Vite), then
// boots the widget: `mountWidget` installs the `window.ryu` bridge + openai shim and
// renders the form inside `WidgetRoot`.

import { mountWidget } from "../../shared/host";
import "../../shared/tokens.css";
import "./styles.css";
import { IntakeForm } from "./IntakeForm";

mountWidget(<IntakeForm />);
