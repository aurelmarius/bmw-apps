# aurelm-airplay-probe

The service behind the app **AirPlay Test** (`apps/aurelm_airplay_probe`): a network test for a future
AirPlay receiver on the iDrive 7 head unit. It answers one question: **can an iPhone find the head unit
as an AirPlay receiver and connect to it?** Nothing is streamed; it is not a receiver.

Idle until the app starts a test. While a test runs (15 minutes from the app, 60 at most):

1. **Firewall.** Accept rules for tcp 7000, 7100 (AirPlay) and udp 5353 (mDNS) go at the top of every
   IPv4 input and output base chain (the unit's own, and mgu-uplink's `inet mgu_uplink`, which lets
   nothing in), for the Wi-Fi-side interfaces only. Every rule carries the comment
   `aurelm-airplay-probe` and is removed when the test ends, when the service stops (also after a
   crash: `cleanup.js` runs as `ExecStopPost`) and at its next start.
2. **mDNS.** A responder on udp 5353 announces `BMW iDrive test` as `_airplay._tcp` and `_raop._tcp`
   (the TXT records open-source receivers such as UxPlay use), answers queries for it, notes every
   AirPlay query (an iPhone asks when Control Center > Screen Mirroring opens), and asks every 10 s who
   is there (`_airplay`, `_raop`, `_companion-link`, `_apple-mobdev2`). Should port 5353 be taken by a
   responder that does not share it, the status names the process that holds it.
3. **AirPlay ports.** tcp 7000 and 7100 note who connects and the first request (`GET /info`,
   `POST /pair-setup`, ...) and answer `503`. The iPhone then says it could not connect: expected.

**Interfaces used:** names `wlan*`, `p2p*`, `wfd*`, `uap*`, `mlan*`, `wl*`, `br*`, `bridge*`, the
uplink `vethuplink`, and any address in `172.20.10.0/28` (an iPhone's Personal Hotspot) or
`172.16.222.0/24` (the car's Wi-Fi). Every other interface is listed in the log, not used.

## Files

| | |
|---|---|
| `probe.js` | the service (root, the unit's `/usr/bin/node`, plain Node 8+) |
| `dns.js`, `airplay.js` | DNS codec, the AirPlay records |
| `nft.js` | the firewall rules |
| `check.js` | the deploy tool's check: the service answers on its socket |
| `cleanup.js` | `ExecStopPost`: removes every rule of the test |

Control socket: `/run/aurelm-airplay-probe/ctl.sock` (root:tm_oap_app 0660), one JSON object per line,
`{"cmd":"status"}`, `{"cmd":"start","minutes":15}`, `{"cmd":"stop"}`; the reply is the status.
The status is also in `/run/aurelm-airplay-probe/status.json`, the last test's in
`/var/opt/aurelm-airplay-probe/state/last-report.json`, and the firewall as it was when the service
started in `state/ruleset-at-start.txt`.

Tests: `node tests/airplay_probe.test.js`. Package: `python3 tools/pack_airplay_test.py`
(`store/airplay-test/`).
