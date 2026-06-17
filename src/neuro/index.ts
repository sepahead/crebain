/**
 * CREBAIN ↔ Engram neuro-cybernetic (NCP) integration.
 *
 * The NCP wire — message types, enums, the `NeuroSimClient` and the WebSocket
 * transport — is the single source of truth in the canonical repo
 * (https://github.com/sepehrmn/NCP), consumed here as the `@sepehrmn/ncp` package
 * (a git dependency pinned by tag in package.json). CREBAIN re-declares none of it:
 * if the protocol has to change, it changes there via a pull request and we bump
 * the pin. This module re-exports the package as CREBAIN's local integration point
 * (`src/neuro`); any CREBAIN-specific TS glue would live here. The CREBAIN-specific
 * mapping (pose/velocity ↔ NCP frames, MAVROS) lives in the Rust client at
 * `src-tauri/src/ncp/`. See README.md.
 */

export * from '@sepehrmn/ncp'
