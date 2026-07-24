// ghost-eyes: cross-platform perception primitives.
// Provides screen capture, accessibility tree, window tracking, and input monitoring.

pub mod accessibility;
pub mod input;
pub mod screen;
pub mod window;

pub use accessibility::{
    accessibility_granted, request_accessibility, AXTree, AXTreeNode, Bounds, PlatformAXTree,
};
pub use input::{InputEvent, InputMonitor, PlatformInputMonitor};
pub use screen::{
    get_primary_display_size, quick_screenshot, request_screen_recording, screen_recording_granted,
    DisplayInfo, Frame, PlatformScreenCapture, ScreenCapture,
};
pub use window::{AppInfo, PlatformWindowTracker, WindowInfo, WindowTracker};
