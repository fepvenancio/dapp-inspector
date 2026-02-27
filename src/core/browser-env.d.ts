/**
 * Ambient type declarations for browser globals referenced in page.evaluate() callbacks.
 * Playwright serializes these functions and runs them in the browser context where
 * document, window, etc. are available. TypeScript needs these declarations since
 * the project's lib config doesn't include "dom".
 */

/* eslint-disable no-var */
declare var document: any
declare var window: any
/* eslint-enable no-var */
