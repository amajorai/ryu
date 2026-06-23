// ghost-eyes: cross-platform perception primitives.
// Provides screen capture, accessibility tree, window tracking, and input monitoring.

pub mod accessibility;
pub mod input;
pub mod screen;
pub mod window;

pub use accessibility::{AXTree, AXTreeNode, Bounds, PlatformAXTree};
pub use input::{InputEvent, InputMonitor, PlatformInputMonitor};
pub use screen::{DisplayInfo, Frame, PlatformScreenCapture, ScreenCapture, quick_screenshot, get_primary_display_size};
pub use window::{AppInfo, PlatformWindowTracker, WindowInfo, WindowTracker};
