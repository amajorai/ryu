// Entry for the Data Grid Explorer widget bundle. Imports the shared design tokens
// and local grid styles (inlined by `vite-plugin-singlefile` — no external fetch),
// then mounts the grid inside the shared `WidgetRoot` wiring shell via `mountWidget`.

import { mountWidget } from "../../shared/host";
import "../../shared/tokens.css";
import "./grid.css";
import { DataGrid } from "./DataGrid";

mountWidget(<DataGrid />);
