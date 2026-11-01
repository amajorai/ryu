// ghost-eyes: cross-platform perception primitives.
// Provides screen capture, accessibility tree, window tracking, and input monitoring.

pub mod accessibility;
pub mod capture_scratch;
pub mod contract;
pub mod input;
pub mod screen;
pub mod window;

pub use accessibility::find::FindOptions;
pub use accessibility::{
    accessibility_granted, request_accessibility, AXTree, AXTreeNode, Bounds, PlatformAXTree,
};
pub use accessibility::{
    AXSnapshot, ActionOptions, ActionOutcome, ActionStep, ElementAction, ElementIdentity,
    ElementLocator, ElementState, MatchBy, RendererA11y, ResolvedElement, SnapshotOptions,
    StepOutcome, Verification, VerificationScope, WalkLimits, WalkStats, WindowTarget,
};
pub use contract::{Delivery, Disposition, ErrorCode, GhostError, Retry};
pub use input::{InputEvent, InputMonitor, PlatformInputMonitor};
pub use screen::{
    get_primary_display_size, quick_screenshot, request_screen_recording, screen_recording_granted,
    DisplayInfo, Frame, PlatformScreenCapture, ScreenCapture,
};
pub use window::{AppInfo, PlatformWindowTracker, WindowInfo, WindowTracker};
