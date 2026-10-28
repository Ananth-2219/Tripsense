"""Untrusted HTTP input boundary. Preserve readings; validate rather than repair."""
from datetime import datetime,timezone
import json,math
from typing import Any, Literal, Optional
from uuid import UUID
from pydantic import BaseModel,ConfigDict,Field,StrictInt,model_validator

MAX_BYTES=8*1024*1024
def numeric(value):return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)
def utc(value):
    dt=datetime.fromisoformat(value.replace('Z','+00:00'))
    if dt.tzinfo is None:raise ValueError('Timezone is required')
    return dt.astimezone(timezone.utc)

class TripPayload(BaseModel):
    model_config=ConfigDict(extra='forbid')
    id:UUID
    startedAt:str
    endedAt:str
    durationSeconds:float=Field(ge=0,le=1800,allow_inf_nan=False)
    motionCount:StrictInt=Field(ge=0,le=30000)
    locationCount:StrictInt=Field(ge=0,le=30000)
    readings:list[dict[str,Any]]=Field(max_length=30000)
    metadata:dict[str,Any]|None=None

    @model_validator(mode='before')
    @classmethod
    def numeric_duration(cls,value):
        if isinstance(value,dict) and not numeric(value.get('durationSeconds')):raise ValueError('Invalid duration')
        return value

    @model_validator(mode='after')
    def valid_recording(self):
        start,end=utc(self.startedAt),utc(self.endedAt)
        if end<start or abs((end-start).total_seconds()-self.durationSeconds)>.001:
            raise ValueError('Recording duration does not match its timestamps')
        motion=location=0
        for r in self.readings:
            kind=r.get('type');ts=r.get('timestamp')
            if not numeric(ts) or not 0<=ts<=253402300799000:raise ValueError('Invalid sensor timestamp')
            if kind=='motion':
                motion+=1;axes=['x','y','z','rotationAlpha','rotationBeta','rotationGamma']
                if set(r)-set(axes+['type','timestamp']):raise ValueError('Unexpected sensor fields')
                if any(r.get(k) is not None and not numeric(r[k]) for k in axes):raise ValueError('Invalid motion value')
            elif kind=='location':
                location+=1
                if set(r)-{'type','timestamp','lat','lon'} or not numeric(r.get('lat')) or not numeric(r.get('lon')) or not -90<=r['lat']<=90 or not -180<=r['lon']<=180:
                    raise ValueError('Invalid GPS reading')
            else:raise ValueError('Unsupported sensor type')
        if motion!=self.motionCount or location!=self.locationCount:raise ValueError('Sample counts differ from readings')
        if self.metadata is not None and len(json.dumps(self.metadata,allow_nan=False).encode())>16384:raise ValueError('Metadata is too large')
        return self

    def record(self):
        return dict(id=str(self.id),started_at=utc(self.startedAt).isoformat(),ended_at=utc(self.endedAt).isoformat(),
            duration_seconds=self.durationSeconds,motion_count=self.motionCount,location_count=self.locationCount,
            readings=self.readings,metadata=self.metadata)

class EvaluationPayload(BaseModel):
    model_config=ConfigDict(extra='forbid')
    comfortRating:Optional[int]=Field(None,ge=0,le=100)
    comfortSkipped:Optional[bool]=None
    scoreAgreement:Optional[Literal['yes','partially','no','not_sure']]=None
    scoreAgreementSkipped:Optional[bool]=None

