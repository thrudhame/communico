import {
  observeFixtureListeners,
  prepareFixtureServerName,
} from '#tests/helpers/fixture-listeners.ts';

observeFixtureListeners();
await prepareFixtureServerName();
await import('#root/main.ts');
