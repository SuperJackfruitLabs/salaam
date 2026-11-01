import { ProviderCredentialStore } from '../../dist/src/providers/auth.js';
const store = new ProviderCredentialStore(process.argv[2]);
await store.modify('openai', async (current) => {
  await new Promise((resolve) => setTimeout(resolve, 25));
  return { ...current, generation: Number(current.generation) + 1 };
});
