#!/usr/bin/env python3
"""ffmpeg-tls.py <ffmpeg tree> - FFmpeg's TLS (OpenSSL) for the head unit: a certificate is checked by default.

FFmpeg 6.1 checks the server's certificate only when asked (tls_verify=1), and with OpenSSL never checks its name.
The hls demuxer opens each segment itself, without the options given to the playlist, so the defaults change here:
when MGU_CA_FILE names a CA list (the service's cacert.pem: the unit has no public one), every https connection is
checked against it, the server's name included; without MGU_CA_FILE FFmpeg behaves as released.
"""
import sys
root = sys.argv[1]

def patch(path, old, new):
    p = root + '/' + path
    s = open(p).read()
    if new in s:
        return
    if s.count(old) != 1:
        sys.exit('ffmpeg-tls.py: %s: anchor not found once' % path)
    open(p, 'w').write(s.replace(old, new))

patch('libavformat/tls.c', '''    ret = set_options(c, uri);
    if (ret < 0)
        return ret;
''', '''    ret = set_options(c, uri);
    if (ret < 0)
        return ret;

    /* the head unit (uxplay-mgu): checked against MGU_CA_FILE by default */
    if (!c->ca_file && getenv("MGU_CA_FILE") && *getenv("MGU_CA_FILE")) {
        c->ca_file = av_strdup(getenv("MGU_CA_FILE"));
        if (!c->ca_file)
            return AVERROR(ENOMEM);
        c->verify = 1;
    }
''')
patch('libavformat/tls_openssl.c', '''        SSL_set_tlsext_host_name(p->ssl, c->host);''', '''        SSL_set_tlsext_host_name(p->ssl, c->host);
    /* the head unit (uxplay-mgu): the certificate must name the host */
    if (c->verify && !c->listen && !c->numerichost && c->host && !SSL_set1_host(p->ssl, c->host)) {
        ret = AVERROR(EIO);
        goto fail;
    }''')
print('ffmpeg-tls.py: TLS checks the certificate and the host when MGU_CA_FILE is set')
