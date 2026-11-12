'use strict';
// Removes every firewall rule the sign-in page put in, so the firewall is as the unit had it, and the player's
// frame file (/dev/shm). Runs as the service's ExecStopPost (also after a crash or a kill) and as the tool's
// deactivate (an uninstall, before anything else goes). Never fails: a failing deactivate would refuse the removal.
try { require('fs').unlinkSync(require('./player').VIDEO_PATH); console.log('aurelm-tvhplayer: removed the frame file'); } catch (e) { /* none */ }
try {
    const n = require('./nft').remove();
    if (n) console.log('aurelm-tvhplayer: removed ' + n + ' firewall rules');
} catch (e) {
    console.log('aurelm-tvhplayer cleanup: ' + (e && e.message));
}
process.exit(0);
