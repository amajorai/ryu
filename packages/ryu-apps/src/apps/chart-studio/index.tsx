// Chart Studio widget entry (spec §5.2). Boots the widget: `mountWidget` installs the
// `window.ryu` bridge + openai compat shim, then renders `<ChartStudio />` inside
// `WidgetRoot` (theme mirror + intrinsic-height reporting). Styles are inlined into the
// single-file CSP bundle by `vite-plugin-singlefile`.

import { mountWidget } from "../../shared/host";
import "../../shared/tokens.css";
import "./styles.css";
import { ChartStudio } from "./ChartStudio";

mountWidget(<ChartStudio />);
