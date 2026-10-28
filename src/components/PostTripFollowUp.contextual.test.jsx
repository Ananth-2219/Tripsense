// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen,act } from '@testing-library/react'
import { afterEach,expect,test,vi } from 'vitest'
import PostTripFollowUp from './PostTripFollowUp.jsx'
const {skip}=vi.hoisted(()=>({skip:vi.fn()}))
vi.mock('../lib/followUps.js',()=>{
 const snapshot={entries:[{id:'test',endedAt:'2026-10-27T00:00:00Z',status:'feedback_pending',score:{state:'failed',retryable:true},answers:{},comments:''}],results:[],loading:false,storageWarning:'',busyIds:[]}
 return {subscribeFollowUps:()=>()=>{},getFollowUpSnapshot:()=>snapshot,initializeFollowUps:async()=>{},
  retryTripUpload:vi.fn(),updateFeedbackDraft:vi.fn(),deferFeedback:vi.fn(),skipFeedback:skip,sendFeedback:vi.fn(),refreshScore:vi.fn(),retryAnalysis:vi.fn(),retryFinalization:vi.fn()}
})
afterEach(cleanup)
test('Skip acknowledgement waits for durable lifecycle persistence before inviting navigation',async()=>{
 let release;skip.mockImplementation(()=>new Promise(resolve=>{release=resolve}))
 render(<PostTripFollowUp/>)
 fireEvent.click(screen.getByRole('button',{name:'Skip questionnaire',exact:true}))
 expect(screen.queryByText('Questionnaire skipped. Your trip is still saved.')).toBeNull()
 await act(async()=>{release()})
 expect(screen.getByText('Questionnaire skipped. Your trip is still saved.')).toBeTruthy()
})
