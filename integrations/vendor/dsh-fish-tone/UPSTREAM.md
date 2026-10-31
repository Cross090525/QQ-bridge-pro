# Upstream provenance

Source: https://github.com/MX3a48c5/dsh-fish-tone
Revision: b22b071644379ae8abb2640c412eef9ea2de49ee
Main package: 0.3.0; flavor package: 0.1.1. License: MIT (see LICENSE).

Only the read-only draft checker (judge.js), its marker scanners and frame definitions, and the static meme/construction dictionaries are retained. The DSH host plugin, global system prompt, HTTP management routes and package-local configuration are excluded.

Local adaptations: marks.js contains only the marker table and scan/density functions; structures.js contains only frame definitions needed by the checker. All rewriting, typo injection, random selection, flavor/tone and grammar generation modules are removed. The bridge adapter exposes a bounded, read-only text.judge through existing content-service permissions. Static dictionaries supplement the existing slang query only when confirmed entries do not match; references remain explicitly unconfirmed and are never learned automatically.
