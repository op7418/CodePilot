/**
 * Adapter catalog — side-effect imports that trigger self-registration
 * of all available channel adapters.
 *
 * To add a new adapter:
 * 1. Create the adapter file (e.g. `discord-adapter.ts`) with self-registration
 * 2. Add a side-effect import line below
 *
 * bridge-manager.ts imports this module; it never needs to change for new adapters.
 */

import './telegram-adapter';
