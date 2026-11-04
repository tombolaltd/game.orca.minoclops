// MOCK BUILD webpack entry — prepended to `entry.app` by game/build/mock-build-plan.js ONLY (the
// enabled branch of webpack.prod.conf.js, "Use mock engine" on).
//
// Plain JS on purpose: the game's dependencies reach TWO different axios module copies, and only
// the bundler can name both. `@game-studio/server-comms` (begin / continue / resume) is a UMD that
// `require('axios')`s — webpack resolves that to axios' `browser.require` build — while ESM
// consumers such as `@game-studio/jackpots`' pot-value poller `import` it and get the ESM build.
// Each copy has its own `defaults`, so both get the mock adapter (installing twice on one copy is a
// no-op).

import axiosEsm from 'axios';
import { installMockClient } from './install-mock-client';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const axiosCjsModule = require('axios');
const axiosCjs = axiosCjsModule && axiosCjsModule.default ? axiosCjsModule.default : axiosCjsModule;

installMockClient({ axiosInstances: [axiosEsm, axiosCjs] });
