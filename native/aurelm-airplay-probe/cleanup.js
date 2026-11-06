'use strict';
// Removes every firewall rule the test put in, so the firewall is as the unit had it. Runs as the
// service's ExecStopPost (also after a crash or a kill) and as the tool's deactivate (an uninstall,
// before anything else goes). Never fails: a failing deactivate would refuse the removal, and with
// nothing to remove (no rules, no nft) there is nothing to do.
try {
    const n = require('./nft').remove();
    if (n) console.log('aurelm-airplay-probe: removed ' + n + ' firewall rules');
} catch (e) {
    console.log('aurelm-airplay-probe cleanup: ' + (e && e.message));
}
process.exit(0);
