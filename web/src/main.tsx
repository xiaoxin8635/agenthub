import React from 'react'
import ReactDOM from 'react-dom/client'
import { App as AntApp } from 'antd'
import { BrowserRouter } from 'react-router-dom'
import App, { Bridge } from './App'
import { ThemeProvider } from './theme'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AntApp>
        <Bridge />
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntApp>
    </ThemeProvider>
  </React.StrictMode>,
)
