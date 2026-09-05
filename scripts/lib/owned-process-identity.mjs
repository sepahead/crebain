/** Classification never grants ownership; the caller must first verify the launched child. */
export function classifyOwnedProcess(original, current) {
  if (!current) return 'missing'
  if (
    current.pid !== original.pid ||
    current.ppid !== original.ppid ||
    current.pgid !== original.pgid ||
    current.started !== original.started
  )
    return 'changed'
  if (current.command === original.command) return 'owned-live'
  if (current.state.startsWith('Z') || current.state.includes('E')) return 'owned-exiting'
  return 'changed'
}
