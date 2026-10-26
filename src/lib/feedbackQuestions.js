export const QUESTIONS = [
  { key: 'phone_placement', title: 'Phone placement', prompt: 'Where was your phone for most of this trip?', options: [
    ['mount', 'In a mount'], ['hand', 'In my hand'], ['pocket', 'In a pocket'], ['bag', 'In a bag'], ['other', 'Somewhere else'], ['unsure', 'Not sure'],
  ] },
  { key: 'phone_stability', title: 'Phone movement / stability', prompt: 'How much did the phone move?', options: [
    ['still', 'Stayed still'], ['slight_movement', 'Moved a little'], ['frequent_movement', 'Moved often'], ['picked_up', 'Picked up or repositioned'], ['unsure', 'Not sure'],
  ] },
  { key: 'road_conditions', title: 'Road conditions', prompt: 'What was most of the road like?', options: [
    ['smooth', 'Mostly smooth'], ['mixed', 'A mix of smooth and bumpy'], ['rough', 'Mostly rough or bumpy'], ['unpaved', 'Mostly unpaved'], ['unsure', 'Not sure'],
  ] },
  { key: 'traffic_conditions', title: 'Traffic conditions', prompt: 'What was traffic like for most of the trip?', options: [
    ['light', 'Light'], ['moderate', 'Moderate'], ['heavy', 'Heavy'], ['stop_go', 'Frequent stopping and starting'], ['unsure', 'Not sure'],
  ] },
  { key: 'driving_smoothness', title: 'Perceived driving smoothness', prompt: 'How did the ride feel overall?', options: [
    ['very_smooth', 'Very smooth'], ['mostly_smooth', 'Mostly smooth'], ['mixed', 'A mix of smooth and rough'], ['rough', 'Mostly rough or jerky'], ['unsure', 'Not sure'],
  ] },
  { key: 'sudden_maneuvers', title: 'Sudden braking, acceleration or turning', prompt: 'Did you notice any sudden movements?', options: [
    ['none', 'None noticed'], ['braking', 'Sudden braking'], ['acceleration', 'Sudden acceleration'], ['turning', 'Sudden turning'], ['multiple', 'More than one of these'], ['unsure', 'Not sure'],
  ] },
  { key: 'unusual_events', title: 'Unusual events', prompt: 'Was there an unusual event? Choose the main one.', options: [
    ['none', 'None noticed'], ['pothole', 'Pothole or road bump'], ['phone_handling', 'Phone dropped or handled'], ['near_miss', 'Near miss or collision'], ['detour', 'Unexpected stop or detour'], ['other', 'Something else'], ['unsure', 'Not sure'],
  ] },
]

export function validateFeedback(answers, comments = '') {
  const errors = {}
  for (const { key, options } of QUESTIONS) {
    if (!options.some(([value]) => value === answers?.[key])) errors[key] = 'Choose one answer, or select Not sure.'
  }
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).some(key => !QUESTIONS.some(q => q.key === key))) {
    errors.form = 'Please use the seven questions below.'
  }
  if (typeof comments !== 'string' || [...comments].length > 1000) errors.comments = 'Keep comments to 1,000 characters or fewer.'
  return errors
}

export function validTripAccess(id, token) {
  return typeof id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
    && typeof token === 'string' && /^[0-9a-f]{64}$/.test(token)
}
