'use strict';
// After the service stops (ExecStopPost), also after a crash or a kill: every firewall rule the test
// put in is removed, so the firewall is as the unit had it.
const n = require('./nft').remove();
if (n) console.log('aurelm-airplay-probe: removed ' + n + ' firewall rules');
