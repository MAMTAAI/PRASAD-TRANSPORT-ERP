import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { installAuthFetch } from './lib/authFetch'
import { installDataChangeBus } from './lib/dataChangeBus'
import './tailwind.css'
import './design-system.css'
import './App.css'

// Sign ERP API calls with the logged-in staff token. Installed FIRST so it is
// the outermost wrapper: it decides the headers, then hands the request to the
// data-change observer, which only watches. Both are no-ops for a caller that
// already set its own Authorization header.
//
// Without this, every guarded route answered 401 and the screens that clear the
// backlog — Exception Resolution above all — could not clear anything.
installAuthFetch()

// Every successful write to /api/v1 now emits 'erp:data-changed', which the
// live panels listen for. Installed before render so no early save is missed.
installDataChangeBus()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)