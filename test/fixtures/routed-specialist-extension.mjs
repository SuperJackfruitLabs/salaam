import providerFixture from './provider-extension.mjs';
import { installSpecialistFixture } from './specialist-extension.mjs';
export default function routed(pi) {
  installSpecialistFixture(pi);
  providerFixture(pi);
}
