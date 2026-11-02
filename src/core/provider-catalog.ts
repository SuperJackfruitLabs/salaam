import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

// Constructing the pinned catalog is offline; never refresh it implicitly during a turn.
export const PI_PROVIDERS = builtinProviders();
