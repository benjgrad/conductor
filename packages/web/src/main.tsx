import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createMockApi } from './api/mock.js';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

// TD: mock API until T09b wires the HTTP client to the T08 orchestrator API.
const api = createMockApi({ latencyMs: 150 });
api.simulate(2000);

createRoot(root).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
