// UX-14 FR-3: the favicon gets a dot while a card needs input. An SVG swap on `link#favicon`
// (index.html); browsers without SVG favicons just don't show the dot, the title count still does.

const MARK =
  '<rect x="4" y="4" width="56" height="56" rx="14" fill="#3b4cca"/>' +
  '<path d="M18 22h28M18 32h20M18 42h24" stroke="#fff" stroke-width="5" stroke-linecap="round"/>';
const DOT = '<circle cx="50" cy="14" r="12" fill="#e5484d" stroke="#fff" stroke-width="3"/>';

const svgUri = (body: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`,
  )}`;

export const FAVICON_PLAIN = svgUri(MARK);
export const FAVICON_DOT = svgUri(MARK + DOT);

export function setFaviconDot(on: boolean): void {
  if (typeof document === 'undefined') return;
  let link = document.querySelector<HTMLLinkElement>('link#favicon');
  if (!link) {
    link = document.createElement('link');
    link.id = 'favicon';
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    document.head.appendChild(link);
  }
  const href = on ? FAVICON_DOT : FAVICON_PLAIN;
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}
