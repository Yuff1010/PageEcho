import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './reader-dock.css'

type DockSlot = 'source' | 'activity' | 'navigation'
const ReaderDockContext = createContext<{
  playerHost: HTMLElement | null
  setPlayerHost: (node: HTMLDivElement | null) => void
  hosts: Partial<Record<DockSlot, HTMLElement | null>>
  register: (name: DockSlot, node: HTMLDivElement | null) => void
} | null>(null)

export function ReaderDockProvider({ children }: { children: ReactNode }) {
  const [playerHost, setPlayerHost] = useState<HTMLDivElement | null>(null)
  const [hosts, setHosts] = useState<Partial<Record<DockSlot, HTMLElement | null>>>({})
  const register = useCallback((name: DockSlot, node: HTMLDivElement | null) => {
    setHosts((previous) => (previous[name] === node ? previous : { ...previous, [name]: node }))
  }, [])
  const value = useMemo(
    () => ({ playerHost, setPlayerHost, hosts, register }),
    [playerHost, hosts, register],
  )
  return <ReaderDockContext.Provider value={value}>{children}</ReaderDockContext.Provider>
}
export function useReaderDock() {
  return useContext(ReaderDockContext)
}

/** The audio element remains owned by player; only its controls move into the reader. */
export function ReaderDockMount() {
  const dock = useReaderDock()
  return <div className="reader-dock-mount" ref={dock?.setPlayerHost} />
}
export function ReaderDockOutlet({ name }: { name: DockSlot }) {
  const dock = useReaderDock()
  const register = dock?.register
  const ref = useCallback((node: HTMLDivElement | null) => register?.(name, node), [name, register])
  return <div className={`reader-dock-slot reader-dock-slot--${name}`} ref={ref} />
}
export function ReaderDockSlot({
  name,
  active = true,
  children,
}: {
  name: DockSlot
  active?: boolean
  children: ReactNode
}) {
  const dock = useReaderDock()
  if (!active) return null
  const host = dock?.hosts[name]
  return host ? createPortal(children, host) : <>{children}</>
}
