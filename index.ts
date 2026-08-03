/**
 * Package entry point.
 *
 * n8n never imports this — it loads the credential and node classes directly
 * from the `dist` paths listed under the `n8n` key in package.json. This file
 * exists so `main` resolves to something real and so the shared types are
 * importable by anyone consuming the package as a library.
 */
export * from './nodes/Gluecrawl/types';
