#!/usr/bin/env python3
"""Changes to UxPlay (at UXPLAY_REV) for the head unit. Each edit must find its text exactly once.

1. lib/global.h: model AppleTV5,4 and version 366.0 by default. iOS 27 sends the screen-mirroring video during a
   CarPlay session only to a receiver that presents itself so (found 2026-11-08 against iCarCast: with
   UxPlay's AppleTV3,2 / 220.68 the iPhone sets up audio only, stream type 96, never 110). Read at run time:
   MGU_MODEL and MGU_SRCVERS give another identity (UxPlay's own, AppleTV3,2 / 220.68, is the one its
   AirPlay video support was made with) without another build; lib/raop.c's Server header follows.
3. lib/http_handlers.h: AirPlay's video button with the AppleTV5,4 identity. iOS starts the video with POST /action
   "playlistInsert" (a play queue) after POST /reverse, never POST /play (found in the car, 2026-11-09: UxPlay logged
   "hls_get_current_video: failed to identify current_playlist", the iPhone sent /stop). With no video yet, the
   inserted item is handled as a /play body; its keys and address are logged. lib/httpd.c logs every request.
2. lib/mdnsd/mdnsd.c: the address mDNS announces comes from UXPLAY_MDNS_IPV4 when set (the head unit has
   several interfaces; the route to 224.0.0.251 is not the car's Wi-Fi), and UXPLAY_MDNS_NO_IPV6 leaves
   IPv6 out (the iPhone reaches the unit over IPv4 on the car's Wi-Fi).

    python3 patch.py <uxplay source folder>
"""
import os, sys

src = sys.argv[1]

def edit(rel, pairs):
    p = os.path.join(src, rel)
    s = open(p, encoding='utf-8').read()
    for a, b in pairs:
        n = s.count(a)
        if n != 1:
            sys.exit('%s: expected 1 match, found %d: %r' % (rel, n, a[:60]))
        s = s.replace(a, b)
    open(p, 'w', encoding='utf-8').write(s)
    print('patched ' + rel)

edit('lib/global.h', [
    ('#define GLOBAL_MODEL    "AppleTV3,2"',
     '/* mgu: the identity, AppleTV5,4 / 366.0 (iOS 27 mirrors during CarPlay) unless MGU_MODEL / MGU_SRCVERS say */\n'
     '#include <stdio.h>\n#include <stdlib.h>\n'
     'static inline const char *mgu_env_or(const char *name, const char *dflt) {\n'
     '    const char *e = getenv(name);\n    return e && *e ? e : dflt;\n}\n'
     'static inline const char *mgu_server_header(void) {\n'
     '    static char b[64];\n    snprintf(b, sizeof b, "AirTunes/%s", mgu_env_or("MGU_SRCVERS", "366.0"));\n    return b;\n}\n'
     '#define GLOBAL_MODEL    mgu_env_or("MGU_MODEL", "AppleTV5,4")'),
    ('#define GLOBAL_VERSION  "220.68"', '#define GLOBAL_VERSION  mgu_env_or("MGU_SRCVERS", "366.0")'),
])

edit('lib/raop.c', [
    ('"Server", "AirTunes/"GLOBAL_VERSION)', '"Server", mgu_server_header())   /* mgu */'),
])

edit('lib/mdnsd/mdnsd.c', [
    ('    int fd;\n    struct sockaddr_in remote;\n',
     '    int fd;\n    struct sockaddr_in remote;\n'
     '    /* mgu: the interface to announce on, given by the service */\n'
     '    const char *forced = getenv("UXPLAY_MDNS_IPV4");\n'
     '    if (forced && inet_pton(AF_INET, forced, &addr) == 1) {\n'
     '        return addr;\n'
     '    }\n'),
    ('    mdnsd->sock_fd6 = mdns_open_socket6(mdnsd->ipv6_scope_id);',
     '    mdnsd->sock_fd6 = getenv("UXPLAY_MDNS_NO_IPV6") ? -1 : mdns_open_socket6(mdnsd->ipv6_scope_id);   /* mgu */'),
])

edit('lib/http_handlers.h', [
    ('#include "fcup_request.h"\n',
     '#include "fcup_request.h"\n\n'
     '/* mgu: a playlistInsert item handled as a /play body (http_handler_action -> http_handler_play) */\n'
     'static plist_t mgu_item = NULL;\n'
     'static void http_handler_play(raop_conn_t *conn, http_request_t *request, http_response_t *response,\n'
     '                              char **response_data, int *response_datalen);\n'
     'static void mgu_log_item(raop_t *raop, plist_t item) {\n'
     '    char keys[512] = "";\n'
     '    plist_dict_iter it = NULL;\n'
     '    plist_dict_new_iter(item, &it);\n'
     '    for (;;) {\n'
     '        char *k = NULL;\n'
     '        plist_t v = NULL;\n'
     '        plist_dict_next_item(item, it, &k, &v);\n'
     '        if (!k) break;\n'
     '        if (strlen(keys) + strlen(k) + 2 < sizeof keys) { if (*keys) strcat(keys, ","); strcat(keys, k); }\n'
     '        plist_mem_free(k);\n'
     '    }\n'
     '    free(it);\n'
     '    char *loc = NULL;\n'
     '    plist_t l = plist_dict_get_item(item, "Content-Location");\n'
     '    if (PLIST_IS_STRING(l)) plist_get_string_val(l, &loc);\n'
     '    logger_log(raop->logger, LOGGER_INFO, "playlistInsert item: %s; Content-Location %.100s", keys, loc ? loc : "none");\n'
     '    plist_mem_free(loc);\n'
     '}\n'),
    ('    /* fetched only after the locals above are initialized: post_action_error releases them */\n',
     '    /* mgu: iOS starts a video on an AppleTV5,4 with playlistInsert, not /play: handled as a /play */\n'
     '    if (raop->current_video < 0) {\n'
     '        int mgu_len = 0;\n'
     '        const char *mgu_data = http_request_get_data(request, &mgu_len);\n'
     '        plist_t mgu_root = NULL;\n'
     '        if (mgu_data && mgu_len > 0) plist_from_bin(mgu_data, mgu_len, &mgu_root);\n'
     '        plist_t mgu_t = mgu_root ? plist_dict_get_item(mgu_root, "type") : NULL;\n'
     '        char *mgu_type = NULL;\n'
     '        if (PLIST_IS_STRING(mgu_t)) plist_get_string_val(mgu_t, &mgu_type);\n'
     '        logger_log(raop->logger, LOGGER_INFO, "POST /action %s with no video yet", mgu_type ? mgu_type : "(no type)");\n'
     '        plist_t mgu_p = mgu_root ? plist_dict_get_item(mgu_root, "params") : NULL;\n'
     '        plist_t mgu_i = PLIST_IS_DICT(mgu_p) ? plist_dict_get_item(mgu_p, "item") : NULL;\n'
     '        if (mgu_type && !strcmp(mgu_type, "playlistInsert") && PLIST_IS_DICT(mgu_i)) {\n'
     '            mgu_log_item(raop, mgu_i);\n'
     '            mgu_item = mgu_i;\n'
     '            http_handler_play(conn, request, response, response_data, response_datalen);\n'
     '            mgu_item = NULL;\n'
     '            plist_mem_free(mgu_type);\n'
     '            plist_free(mgu_root);\n'
     '            return;\n'
     '        }\n'
     '        plist_mem_free(mgu_type);\n'
     '        if (mgu_root) plist_free(mgu_root);\n'
     '    }\n'
     '    /* fetched only after the locals above are initialized: post_action_error releases them */\n'),
    ('    if (!data_is_binary_plist) {\n         logger_log(raop->logger, LOGGER_ERR, "Play request Content is not binary_plist (unsupported)");',
     '    if (!data_is_binary_plist && !mgu_item) {\n         logger_log(raop->logger, LOGGER_ERR, "Play request Content is not binary_plist (unsupported)");'),
    ('    plist_from_bin(request_data, request_datalen, &req_root_node);\n\n    plist_t req_uuid_node',
     '    if (mgu_item) req_root_node = plist_copy(mgu_item);   /* mgu: the playlistInsert item */\n'
     '    else plist_from_bin(request_data, request_datalen, &req_root_node);\n\n    plist_t req_uuid_node'),
])

# every request of the client logged (UxPlay: with -d only); the service drops /feedback (every 2 s) and shortens the rest
edit('lib/httpd.c', [
    ('                if (logger_debug) {\n                    const char *method = http_request_get_method(connection->request);',
     '                if (1) {   /* mgu: always */\n                    const char *method = http_request_get_method(connection->request);'),
])

# an end of video with no video (the iPhone ended it first): ignored, not an assert (in the car, 0.9.4: the receiver
# aborted, "raop_handle_eos: Assertion `id >= 0' failed", and was started again)
edit('lib/raop.c', [
    ('    int id = raop->current_video;\n    assert (id >= 0);\n',
     '    int id = raop->current_video;\n    if (id < 0) return;   /* mgu: the video was ended already */\n'),
])
