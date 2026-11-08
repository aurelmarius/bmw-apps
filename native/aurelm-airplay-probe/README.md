# aurelm-airplay-probe

The service behind the app **AirPlay Test** (`apps/aurelm_airplay_probe`): a network test for a future
AirPlay receiver on the iDrive 7 head unit. It answers one question: **can an iPhone find the head unit
as an AirPlay receiver and connect to it?** Nothing is streamed; it is not a receiver.

**Nothing runs at boot.** systemd listens on `/run/aurelm-airplay-probe.sock` (socket activation); the
app's first connection starts the service, and it exits by itself 10 minutes after the last test and
the last request. Idle until the app starts a test. While a test runs (15 minutes from the app, 60 at
most):

1. **Firewall.** Accept rules go at the top of every IPv4 input and output base chain (the unit's own
   `ip filter`, which its firewall drops in by default, and mgu-uplink's `inet mgu_uplink`, which lets
   nothing in), for the Wi-Fi-side interfaces only: in, tcp 7000, 7100 (AirPlay) and udp 5353 (mDNS);
   out, tcp 7000, 7100 and udp 5353 from root only (this service, not the car's own responder). Only
   accepts, never a drop. Every rule carries the comment `aurelm-airplay-probe`; the rules are put back
   when a ruleset load drops them, and removed when the test ends.
2. **mDNS.** A responder on udp 5353 announces `BMW iDrive test` as `_airplay._tcp` and `_raop._tcp`
   (the TXT records open-source receivers such as UxPlay use), answers queries for it, notes every
   AirPlay query (an iPhone asks when Control Center > Screen Mirroring opens), and asks every 10 s who
   is there (`_airplay`, `_raop`, `_companion-link`, `_apple-mobdev2`). Should port 5353 be taken by a
   responder that does not share it, the status names the process that holds it.
3. **AirPlay ports.** tcp 7000 and 7100 note who connects and the first request (`GET /info`,
   `POST /pair-setup`, ...) and answer `503`. The iPhone then says it could not connect: expected.

**Interfaces used:** names `wlan*` (the car's hotspot is `wlan_bridge`), `p2p*`, `wfd*`, `uap*`,
`mlan*`, `wl*`, `br*`, `bridge*`, the uplink `vethuplink`, and any address in `172.20.10.0/28` (an
iPhone's Personal Hotspot) or `172.16.222.0/24` (the car's Wi-Fi). Every other interface is listed in
the log, not used.

## Removal leaves nothing

| What | Gone by |
|---|---|
| firewall rules | the end of the test; the service's `ExecStopPost` (`cleanup.js`, after a stop, a crash, a kill or the OOM killer); the tool's `deactivate` (`cleanup.js` again, the first step of an uninstall); a reboot (the unit loads its ruleset afresh) |
| `/var/opt/aurelm-airplay-probe/` (versions, `state/`: the receiver's identity, the last report) | the deploy tool's uninstall (removes the tool's whole folder) |
| `aurelm-airplay-probe.socket`, `.service`, the `sockets.target` link, the deploy tool's limits drop-in, the recmgr names | the deploy tool's uninstall |
| `/run/aurelm-airplay-probe.sock` | the socket's stop (`RemoveOnStop=yes`) |
| the announcement on the network | a goodbye (TTL 0) when the test ends |

Nothing is written under `/` (the read-only root file system), no stock file or unit is touched, no
drop-in goes on a unit of the car's.

## Head-unit safety

What the Store's tools learned the hard way (mgu-store, waze-on-cluster), and how this service follows it:

- **No core dump to the crash handler** (it restarts the head unit for a program it does not list):
  `LimitCORE=1` on the service, no root `+` commands (systemd gives them no limits), and every `nft`
  runs as `sh -c 'ulimit -c 1; exec nft ...'`, so also from the deploy tool's `deactivate` hook.
- **recmgr** lists `aurelm-airplay-probe` (the deploy tool writes it): a crash or exit restarts the
  service, never the head unit. A start limit (10 in 10 minutes) leaves it failed instead of looping.
- **Node 8.9.4** (the 2019 head units' `/usr/bin/node`): plain Node 8 JavaScript; the tests run on
  8.9.4 too.
- **No umask trap:** the service writes only its own files under `/var/opt/aurelm-airplay-probe`, read
  by root; the app reaches it through the socket, whose mode and owner are set explicitly.
- **The socket is the app's alone:** every OAP app is in `tm_oap_app`, so a socket in that group would
  let any installed app start the test and open the ports (Vizualyse/idrive-apps,
  `knowledge/head-unit.md`). `sockgroup.js` (the socket's `ExecStartPost`, and the service at each
  start) gives it the AirPlay Test app's own group, found by its package name under
  `/var/opt/public/oap`, mode 0660; root only (0600) while the app is not installed. The group is read
  when the socket starts: after a fresh install, restart the head unit once.
- **No boot ordering:** nothing waits for it, it waits for nothing of the car's; it does not run at boot.
- **Bounded:** nice 10, idle I/O, 20% CPU, 64 MiB, 16 tasks.
- **CarPlay:** during a test the service shares udp 5353 with the car's own mDNS responder
  (`SO_REUSEADDR`). Multicast reaches both; a unicast mDNS packet may reach only one of them. Run the
  test with CarPlay already connected, and stop it when done.

## Files

| | |
|---|---|
| `probe.js` | the service (root, the unit's `/usr/bin/node`) |
| `dns.js`, `airplay.js` | DNS codec, the AirPlay records |
| `nft.js` | the firewall rules |
| `check.js` | the deploy tool's check: the service answers on its socket |
| `cleanup.js` | `ExecStopPost` and `deactivate`: removes every rule of the test, never fails |
| `sockgroup.js` | the control socket's group: the app's own, never `tm_oap_app` |

Control: one JSON object per line on the socket, `{"cmd":"status"}`, `{"cmd":"start","minutes":15}`,
`{"cmd":"stop"}`; the reply is the status. The last test's status is kept in
`/var/opt/aurelm-airplay-probe/state/last-report.json` (every 30 s while it runs, and at its end).

Tests: `node tests/airplay_probe.test.js` (also on Node 8.9.4). Package:
`python3 tools/pack_airplay_test.py` (`store/airplay-test/`).
