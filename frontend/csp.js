/**
 * The Content-Security-Policy of the production build, as a <meta> tag in index.html.
 *
 * S3 cannot send response headers and the managed CloudFront policy has no CSP, so the page
 * carries it itself. It allows only what the built app loads: its own scripts, styles, images
 * and fonts (same origin), inline styles (Material UI's Emotion injects <style> tags) and API
 * calls to its own origin (CloudFront serves the app and /api/tracker from one domain).
 * frame-ancestors cannot be set from a meta tag; the CloudFront policy's X-Frame-Options
 * covers framing.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/**
 * Vite plugin: inject the policy into index.html, in production builds only. The dev server
 * needs inline scripts and a websocket for hot reload, and talks to the API on another port,
 * so it gets no policy.
 *
 * @returns {import('vite').Plugin} The plugin.
 */
export function cspMetaPlugin() {
  return {
    name: 'acme-csp-meta',
    apply: 'build',
    transformIndexHtml() {
      return [{
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
        injectTo: 'head-prepend',
      }];
    },
  };
}
