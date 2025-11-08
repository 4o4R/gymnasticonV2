// Re-export everything from the CLI/App entry point so package consumers can import Gymnasticon APIs via `import {...} from "gymnasticon"`.
export * from './app/index.js'; // Star export mirrors the structure defined in src/app/index.js without duplicating symbols here.
