import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('@conductor/web scaffold', () => {
  it('renders the placeholder app', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('<h1>Conductor</h1>');
    expect(html).toContain('@conductor/web ok: true');
  });
});
