#!/usr/bin/env python3
"""Packs every tool in native/<id>/ (a component.json) into packages/<id>@<version>.tgz.

    python3 tools/pack_tools.py

The deploy tool's artifact format (mgu-store deploy/README.md, "Artifacts"): component.json at the root
with a sha256 per file, files/<path>, units/<name>; members sorted, owned 0:0, one mtime, gzip without
a time: the same tree always gives the same bytes. Older versions of a tool in packages/ are removed.
"""
import glob, gzip, hashlib, io, json, os, sys, tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKAGES = os.path.join(ROOT, 'packages')
MTIME = 1792281600  # 2026-10-18
# what the deploy tool reads; requires and uninstallable are the catalog's
PASS = ('mguHmi', 'mguProvides', 'keepRunning', 'crashNames', 'postInstall', 'check', 'activate', 'deactivate')


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def tgz(entries):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as tf:
        for name, data, mode in entries:
            ti = tarfile.TarInfo(name)
            ti.size, ti.mode, ti.mtime, ti.uid, ti.gid, ti.uname, ti.gname = len(data), mode, MTIME, 0, 0, 'root', 'root'
            tf.addfile(ti, io.BytesIO(data))
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode='wb', mtime=0) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def pack(tool_dir):
    c = json.load(open(os.path.join(tool_dir, 'component.json')))
    if c.get('kind') != 'tool':
        sys.exit('%s: kind is not "tool"' % tool_dir)
    entries, files, units, dropins = [], [], [], []
    for f in c.get('files', []):
        data = open(os.path.join(tool_dir, f.get('from', f['path'])), 'rb').read()
        entries.append(('files/' + f['path'], data, int(f['mode'], 8)))
        files.append({'path': f['path'], 'mode': f['mode'], 'sha256': sha256(data)})
    for u in c.get('units', []):
        entries.append(('units/' + u['name'], open(os.path.join(tool_dir, u.get('from', u['name'])), 'rb').read(), 0o644))
        units.append({'name': u['name']})
    for d in c.get('dropins', []):
        entries.append(('dropins/%s.d/%s' % (d['unit'], d['name']), open(os.path.join(tool_dir, d.get('from', d['name'])), 'rb').read(), 0o644))
        dropins.append({'unit': d['unit'], 'name': d['name']})
    m = {'id': c['id'], 'kind': 'tool', 'version': c['version'], 'title': c.get('title', c['id']), 'description': c.get('description', ''),
         'files': files, 'units': units, 'enable': c.get('enable', []), 'recmgr': c.get('recmgr', []), 'restart': c.get('restart', [])}
    if dropins:
        m['dropins'] = dropins
    if 'internet' in c:
        m['internet'], m['uids'] = c['internet'], c.get('uids')
    for k in PASS:
        if k in c:
            m[k] = c[k]
    entries.append(('component.json', (json.dumps(m, indent=2) + '\n').encode(), 0o644))
    entries.sort(key=lambda e: e[0])
    for old in glob.glob(os.path.join(PACKAGES, c['id'] + '@*.tgz')):
        os.remove(old)
    name = '%s@%s.tgz' % (c['id'], c['version'])
    data = tgz(entries)
    open(os.path.join(PACKAGES, name), 'wb').write(data)
    print('%s  %d bytes' % (name, len(data)))


def main():
    os.makedirs(PACKAGES, exist_ok=True)
    for d in sorted(glob.glob(os.path.join(ROOT, 'native', '*', 'component.json'))):
        pack(os.path.dirname(d))


if __name__ == '__main__':
    main()
