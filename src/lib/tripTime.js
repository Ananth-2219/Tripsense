export function tripTime(endedAt) {
  const date = new Date(endedAt)
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'your saved trip'
}
