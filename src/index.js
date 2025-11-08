// ─────────────────────────────────────────────────────────────────────────────
// File: src/index.js
// Role: Define the top-level public interface for the Gymnasticon package.
// Teaching note: npm packages usually expose a single entry file so consumers
// can import everything from one place (e.g., `import { App } from 'gymnasticon'`).
// ─────────────────────────────────────────────────────────────────────────────

// This lone export statement re-exports every symbol from the deeper
// `src/app/index.js` module. Breaking down the syntax helps understand ES modules:
//   • `export` → makes the statement part of the public interface.
//   • `*`      → forward *all* named exports (like App, defaults, helpers).
//   • `from`   → specifies which module actually defines those exports.
//   • `'./app/index.js'` → relative path to the real implementation.
// Because of this forwarding, package users never need to know our folder
// layout—they just import from the package root and get every symbol we expose.
export * from './app/index.js'; // Actual code line executing the behavior described above.
