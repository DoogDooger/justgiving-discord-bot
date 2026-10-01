import type { Config } from './config.js';
import type { DonationDeps } from './donations.js';
import type { PageDirectory } from './pages.js';
import type { ProfileDirectory } from './profiles.js';

/** Everything command handlers and web routes need, built once in index.ts. */
export interface AppContext {
  config: Config;
  donations: DonationDeps;
  pages: PageDirectory;
  profiles: Pick<ProfileDirectory, 'getMany'>;
}
