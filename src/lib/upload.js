import { supabase } from './supabase.js'

export async function uploadTrip({
  startedAt, endedAt, durationSeconds, motionCount, locationCount, readings, metadata = null,
}) {
  try {
    // Do not select the inserted row: uploading only needs INSERT permission.
    const { error } = await supabase.from('trips').insert({
      started_at: startedAt,
      ended_at: endedAt,
      duration_seconds: durationSeconds,
      motion_count: motionCount,
      location_count: locationCount,
      readings,
      metadata,
    })
    if (error) {
      return { success: false, error: { message: 'Could not upload trip.', code: error.code ?? null } }
    }
    return { success: true, error: null }
  } catch {
    // Network exception text can contain connection details; return a safe message.
    return { success: false, error: { message: 'Could not upload trip. Check your connection.', code: null } }
  }
}

