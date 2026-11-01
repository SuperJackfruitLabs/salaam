// The harness module's public entry point: only what other modules import. Keep it minimal.
export { DockerHarnessBackend } from './backend.js';
export { type HarnessPin, probeHarness } from './probe.js';
