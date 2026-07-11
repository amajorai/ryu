// Entry for the Worktree Diff Review widget bundle. Imports the shared design tokens
// and this app's local styles (inlined into the single-file HTML by Vite), then mounts
// the component through the shared host shell (installs the bridge + openai shim,
// applies the host theme, reports intrinsic height).

import { mountWidget } from "../../shared/host";
import "../../shared/tokens.css";
import "./styles.css";
import { DiffReview } from "./DiffReview";

mountWidget(<DiffReview />);
