// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import TripScore from './TripScore.jsx'
afterEach(cleanup)
test('renders calculated provisional score, three components, quality and compact breakdown',()=>{
 render(<TripScore entry={{id:'trip',score:{state:'ready',status:'provisional',baselineScore:80.3079585967,components:{A:75.623,J:80.584,R:86.426},baselineWeights:{A:.35,J:.4,R:.25},quality:{motion_coverage_percent:99.569,observed_motion_seconds:1792.242,duration_seconds:1800,warnings:['Phone placement unverified.']}}}} />)
 expect(screen.getByText('80.31')).toBeTruthy()
 expect(screen.getByText('Provisional ride-smoothness score')).toBeTruthy()
 expect(screen.getByText('75.62')).toBeTruthy()
 expect(screen.getByText(/99.57%/)).toBeTruthy()
 expect(screen.getByText('Score breakdown')).toBeTruthy()
})
test('pending is an actual analysis state, never a percentage',()=>{
 render(<TripScore entry={{id:'trip',score:{state:'processing'}}} />)
 expect(screen.getByText('Analyzing ride')).toBeTruthy()
 expect(screen.queryByText(/\d+%/)).toBeNull()
})
test('failed scoring preserves saved-ride message and offers metadata-only retry',()=>{
 const retry=vi.fn();render(<TripScore entry={{id:'trip',score:{state:'failed',retryable:true,reason:'Connection interrupted.'}}} onRetry={retry} />)
 fireEvent.click(screen.getByRole('button',{name:'Retry analysis'}))
 expect(retry).toHaveBeenCalledWith('trip')
 expect(screen.getByText(/Your ride is saved/)).toBeTruthy()
 expect(screen.queryByText('100.00')).toBeNull()
})
