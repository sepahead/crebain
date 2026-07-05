export const TRANSPORT_EVENT_PREFIX = 'crebain:transport:'

/**
 * Map a ROS topic to a Tauri event name.
 *
 * Tauri 2.x (`EventName::new`) rejects event names containing anything
 * outside alphanumerics, `-`, `/`, `:` and `_`, so an emit with an illegal
 * name fails and the frontend never receives the payload. ASCII
 * alphanumerics, `-` and `/` pass through; every other byte is escaped as
 * `_` + two uppercase hex digits (`_` itself becomes `_5F`, keeping the
 * mapping bijective). Must stay byte-identical with `transport_event_name`
 * in `src-tauri/src/transport/commands.rs`.
 */
export function getTransportEventName(topic: string): string {
  const bytes = new TextEncoder().encode(topic)
  let encoded = TRANSPORT_EVENT_PREFIX

  for (const byte of bytes) {
    const char = String.fromCharCode(byte)
    encoded += /^[A-Za-z0-9/-]$/.test(char)
      ? char
      : `_${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }

  return encoded
}
