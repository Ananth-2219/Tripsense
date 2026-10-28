// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen } from '@testing-library/react'
import { afterEach,expect,test,vi } from 'vitest'
import TripScore from './TripScore.jsx'
afterEach(cleanup)
const entry={id:'trip',feedbackComplete:true,feedbackDisposition:'submitted',score:{state:'ready',status:'final',baselineScore:81,
 components:{A:80,J:82,R:81},quality:{observed_motion_seconds:9,duration_seconds:10,motion_coverage_percent:90,warnings:['Some motion is missing.']},
 contextual:{state:'final',policyVersion:'experimental-contextual-scoring/3.0.0',finalScore:77,sensorScore:80,deltaFromBaseline:-4,
 weights:{A:.4,J:.4,R:.2},experienceScore:65,experienceContribution:6.5,incidentPenalty:1.5,effects:[{field:'road_condition',label:'Road conditions',answer:'mixed'}],fallbackFields:[]}}}
test('final card shows actual final baseline contextual and delta without stale provisional label',()=>{
 render(<TripScore entry={entry}/>)
 expect(screen.getByRole('heading',{name:'Final ride-smoothness score'})).toBeTruthy()
 expect(screen.getByText('77.00')).toBeTruthy();expect(screen.getByText(/Original baseline/)).toBeTruthy();expect(screen.getByText(/Contextual sensor/)).toBeTruthy()
 expect(screen.getByText(/−4.00|-4.00/)).toBeTruthy();expect(screen.queryByRole('heading',{name:'Provisional ride-smoothness score'})).toBeNull()
 expect(screen.getByText(/Road conditions/)).toBeTruthy()
 fireEvent.click(screen.getByText('Score breakdown'))
 expect(screen.getByText(/Adjusted weights/)).toBeTruthy();expect(screen.getByText(/Incident-experience penalty/)).toBeTruthy()
})
test('failed contextual finalization preserves baseline and offers retry without another questionnaire',()=>{
 const retry=vi.fn()
 render(<TripScore entry={{...entry,score:{...entry.score,status:'provisional',contextual:{state:'failed',reason:'Offline'}}}} onFinalize={retry}/>)
 expect(screen.getAllByText('81.00').length).toBeGreaterThan(0);expect(screen.getByText(/Your feedback is saved/)).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'Retry final score'}));expect(retry).toHaveBeenCalledWith('trip')
})
