// Quest Board widget entry (spec §5.3, app rank 6). Boots the drag-drop kanban
// component into the widget iframe: imports the shared design tokens + local
// styles (both inlined into the single-file bundle by `vite-plugin-singlefile`),
// then hands the tree to `mountWidget`, which installs the bridge, aliases
// `window.openai`, applies the host theme, and reports intrinsic height.

import "../../shared/tokens.css";
import "./quest-board.css";
import { mountWidget } from "../../shared/host";
import { QuestBoard } from "./QuestBoard";

mountWidget(<QuestBoard />);
