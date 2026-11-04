'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'client', 'controller.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'client', 'css', 'style.css'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'client', 'service-worker.js'), 'utf8');

const controllerCssStart = css.indexOf('/* ─── Controller-specific');
const controllerCssEnd = css.indexOf('/* Lobby waiting screen on computer');
if (controllerCssStart < 0 || controllerCssEnd < 0) {
  throw new Error('Controller CSS boundaries not found');
}

const controllerCss = css.slice(controllerCssStart, controllerCssEnd);
const forbiddenViewportUnits = /\b(?:dvh|dvw|vh|vw)\b/i;
const forbiddenViewportMedia = /@media[^{}]*(?:orientation|max-height|max-width|aspect-ratio)/i;

if (!html.includes('id="ctrl-stage"') || !html.includes('Versión b11')) {
  throw new Error('Controller stage or build marker is missing');
}
if (!html.includes('viewport-fit=cover')) {
  throw new Error('Controller viewport meta must use viewport-fit=cover');
}
if (forbiddenViewportUnits.test(controllerCss)) {
  throw new Error('Controller CSS must use stage/container units instead of viewport units');
}
if (forbiddenViewportMedia.test(controllerCss)) {
  throw new Error('Controller CSS must not use viewport/orientation media queries');
}
if (!sw.includes('road-rumble-shell-v5') || !sw.includes('/js/controller.js?v=16')) {
  throw new Error('Controller cache version was not bumped');
}

console.log('Controller layout static checks passed (stage, viewport, units, cache, build).');
