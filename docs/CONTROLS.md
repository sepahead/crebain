# CREBAIN Keyboard Controls

The authoritative machine source is `src/lib/shortcuts.ts` (plus the literal
bindings in `CrebainViewer.tsx`, `ObjectTransformControls.tsx`, and
`useObjectSelection.ts`). This file is the human-readable reference.

## Navigation (free-fly camera)

| Key      | Action                                                    |
| -------- | --------------------------------------------------------- |
| W/A/S/D  | Move forward/left/back/right                              |
| Q/E      | Move down/up                                              |
| Z/X or ←/→ | Rotate camera left/right                                |
| Shift    | Sprint (3x speed)                                         |
| Ctrl/Cmd | Precision mode (0.2x speed)                               |
| Space    | Emergency stop (zero velocity)                            |
| R        | Reset camera to the default view (home position, looking at the origin) |

Navigation keys are suppressed while a drone is selected — the drone control
scheme below owns them.

## Camera System

| Key | Action                   |
| --- | ------------------------ |
| 1   | Place Static Camera (SK) |
| 2   | Place PTZ Camera         |
| 3   | Place Patrol Camera (PK) |
| Tab | Cycle through cameras    |
| V   | Toggle camera feeds      |

## Panels & UI

| Key        | Action                                                        |
| ---------- | ------------------------------------------------------------- |
| P          | Toggle Performance Panel                                      |
| F          | Focus scene content                                           |
| G          | Toggle 3D grid                                                |
| N          | Toggle ROS Connection Panel                                   |
| U          | Expand/collapse Sensor Fusion Panel                           |
| T          | Toggle detection panel                                        |
| Y          | Toggle detection on/off                                       |
| M          | Toggle splat performance mode (caps at 1.5M splats and reloads the current splat in place; press again to reload at full quality) |
| Ctrl/Cmd+O | Open scene file                                               |
| Esc        | Cancel placement / clear selection                            |

## Drone Control (drone selected)

| Key     | Action                       |
| ------- | ---------------------------- |
| W/S/A/D | Horizontal flight            |
| Q/E     | Yaw left/right               |
| Space   | Throttle up                  |
| Shift   | Throttle down                |
| R       | Arm/disarm                   |
| Esc     | Emergency disarm (all drones) |

The Esc emergency disarm is deliberately **global**: it fires even when no
drone is selected, when flight controls are disabled, and while focus is inside
a text field — and it fires in addition to (not instead of) the Esc "cancel
placement / clear selection" action above. A `C` camera-switch binding is
reserved in the shortcut constants but is not currently wired to any behavior.

## Object Transform (object selected)

| Key           | Action              |
| ------------- | ------------------- |
| I/K           | Rotate around X     |
| J/L           | Rotate around Y     |
| ,/.           | Rotate around Z     |
| +/-           | Scale up/down (`=` and `_` also work, i.e. with or without Shift) |
| Del/Backspace | Delete object       |
