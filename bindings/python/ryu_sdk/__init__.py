"""Ryu SDK Python binding package.

The importable API lives in the GENERATED sibling module `ryu_sdk.py` (emitted by
`uniffi-bindgen` from `crates/ryu-sdk-uniffi`; gitignored). This thin, COMMITTED
`__init__.py` re-exports it so callers `import ryu_sdk` and reach the surface
directly (`ryu_sdk.validate_plugin_id`, `ryu_sdk.ModelClient`, `ryu_sdk.RyuError`,
...), matching the smoke test + pyproject.

Without this file Python 3 would treat `ryu_sdk/` as an empty namespace package
and the generated module would be unreachable as `ryu_sdk`.
"""

from .ryu_sdk import *  # noqa: F401,F403  (re-export the generated UniFFI surface)
from .ryu_sdk import __all__  # noqa: F401  (forward the generated export list)
