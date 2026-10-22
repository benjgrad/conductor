import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createApiFromEnv } from './api/select.js';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

// VITE_API=mock runs on the in-memory mock; the default is the orchestrator API (api/select.ts).
const { api } = createApiFromEnv(import.meta.env);

createRoot(root).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
