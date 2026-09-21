import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

type MapWithInsert<K, V> = Map<K, V> & {
  getOrInsertComputed?: (key: K, compute: (key: K) => V) => V
}

const mapPrototype = Map.prototype as MapWithInsert<unknown, unknown>

if (typeof mapPrototype.getOrInsertComputed !== 'function') {
  Object.defineProperty(Map.prototype, 'getOrInsertComputed', {
    configurable: true,
    writable: true,
    value(key: unknown, compute: (key: unknown) => unknown) {
      if (!this.has(key)) {
        this.set(key, compute(key))
      }

      return this.get(key)
    },
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
