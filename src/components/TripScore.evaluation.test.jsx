// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import TripScore from './TripScore.jsx'

afterEach(cleanup)

const baseEntry = {
  id: 'trip-123',
  score: {
    state: 'ready',
    status: 'provisional',
    baselineScore: 82.5,
    components: { A: 80, J: 85, R: 82 },
    baselineWeights: { A: 0.35, J: 0.4, R: 0.25 },
    quality: { motion_coverage_percent: 98, observed_motion_seconds: 100, duration_seconds: 100 },
  },
}

test('comfort rating question is displayed and numerical score is hidden before rating or skip', () => {
  const onComfortRating = vi.fn()
  const onSkipComfort = vi.fn()

  render(
    <TripScore
      entry={{
        ...baseEntry,
        evaluation: {
          comfortRating: null,
          comfortSubmitted: false,
          comfortSkipped: false,
          scoreAgreement: null,
          agreementSubmitted: false,
          agreementSkipped: false,
        },
      }}
      onComfortRating={onComfortRating}
      onSkipComfort={onSkipComfort}
    />
  )

  // Comfort question MUST be in the document
  expect(screen.getByText('How comfortable and smooth did this ride feel?')).toBeTruthy()
  expect(screen.getByRole('slider')).toBeTruthy()
  expect(screen.getByText('0 = Extremely uncomfortable')).toBeTruthy()
  expect(screen.getByText('100 = Extremely smooth')).toBeTruthy()

  // Numerical score MUST NOT be displayed before rating or skip
  expect(screen.queryByText('82.50')).toBeNull()
  expect(screen.queryByText('/100')).toBeNull()

  // Clicking "Save rating & view score" calls callback with default 50
  fireEvent.click(screen.getByRole('button', { name: 'Save rating & view score' }))
  expect(onComfortRating).toHaveBeenCalledWith('trip-123', 50)

  // Or clicking "Skip" calls skip callback
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
  expect(onSkipComfort).toHaveBeenCalledWith('trip-123')
})

test('changing comfort slider updates value before submitting', () => {
  const onComfortRating = vi.fn()

  render(
    <TripScore
      entry={{
        ...baseEntry,
        evaluation: {
          comfortRating: null,
          comfortSubmitted: false,
          comfortSkipped: false,
        },
      }}
      onComfortRating={onComfortRating}
    />
  )

  const slider = screen.getByRole('slider')
  fireEvent.change(slider, { target: { value: '88' } })

  fireEvent.click(screen.getByRole('button', { name: 'Save rating & view score' }))
  expect(onComfortRating).toHaveBeenCalledWith('trip-123', 88)
})

test('numerical score is revealed and score agreement is offered once comfort rating is submitted', () => {
  const onScoreAgreement = vi.fn()
  const onSkipAgreement = vi.fn()

  render(
    <TripScore
      entry={{
        ...baseEntry,
        evaluation: {
          comfortRating: 88,
          comfortSubmitted: true,
          comfortSkipped: false,
          scoreAgreement: null,
          agreementSubmitted: false,
          agreementSkipped: false,
        },
      }}
      onScoreAgreement={onScoreAgreement}
      onSkipAgreement={onSkipAgreement}
    />
  )

  // Numerical score IS revealed
  expect(screen.getByText('82.50')).toBeTruthy()
  expect(screen.getByText('Provisional ride-smoothness score')).toBeTruthy()

  // Score agreement question appears
  expect(screen.getByText('Does this score match your experience?')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Partially' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'No' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Not sure' })).toBeTruthy()

  // Clicking choice calls onScoreAgreement
  fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
  expect(onScoreAgreement).toHaveBeenCalledWith('trip-123', 'yes')

  // Clicking skip calls onSkipAgreement
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
  expect(onSkipAgreement).toHaveBeenCalledWith('trip-123')
})

test('numerical score is revealed when comfort rating was skipped', () => {
  render(
    <TripScore
      entry={{
        ...baseEntry,
        evaluation: {
          comfortRating: null,
          comfortSubmitted: false,
          comfortSkipped: true,
          scoreAgreement: null,
          agreementSubmitted: false,
          agreementSkipped: false,
        },
      }}
    />
  )

  expect(screen.getByText('82.50')).toBeTruthy()
  expect(screen.getByText('Does this score match your experience?')).toBeTruthy()
})

test('score agreement recorded confirmation is shown when agreement was chosen', () => {
  render(
    <TripScore
      entry={{
        ...baseEntry,
        evaluation: {
          comfortRating: 88,
          comfortSubmitted: true,
          comfortSkipped: false,
          scoreAgreement: 'partially',
          agreementSubmitted: true,
          agreementSkipped: false,
        },
      }}
    />
  )

  expect(screen.getByText('82.50')).toBeTruthy()
  expect(screen.getByText(/Score agreement recorded:/)).toBeTruthy()
  expect(screen.getByText('partially')).toBeTruthy()
})
