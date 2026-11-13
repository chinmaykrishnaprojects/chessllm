import { useSyncExternalStore } from 'react'
import { getEngineStatus, subscribeStatus } from '../lib/recoveryApi'

export default function EngineStatus() {
  const status = useSyncExternalStore(subscribeStatus, getEngineStatus)
  return <div role={status.error ? 'alert' : 'status'} aria-live="polite"
    style={{ padding: '5px 16px', fontSize: 12, color: status.error ? '#ff9b9b' : '#b0b0b0', background: '#262421' }}>
    {status.text}
  </div>
}
