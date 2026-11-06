#!/usr/bin/env python3
"""The AirPlay network test as a Store catalog: store/airplay-test/

    python3 tools/pack_airplay_test.py

Builds the app (kit/tools/build.py aurelm_airplay_probe), packs the service's tool kit from
native/aurelm-airplay-probe/component.json in the deploy tool's artifact format (component.json with a
sha256 per file, files/<path>, units/<name>; sorted, owner 0:0, one mtime) and writes catalog.json
(schema 2, artifact URLs relative to it). The folder is a Store source two ways:

  - HTTPS: https://raw.githubusercontent.com/aurelmarius/bmw-apps/refs/heads/<branch>/store/airplay-test/catalog.json
  - a USB stick: the folder's files in mgu-repo/airplay-test/ on the stick

It is kept apart from packages/ and catalog.json at the root, which the release workflow publishes.
"""
import glob, gzip, hashlib, io, json, os, shutil, subprocess, sys, tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = 'aurelm_airplay_probe'
TOOL_DIR = os.path.join(ROOT, 'native', 'aurelm-airplay-probe')
OUT = os.path.join(ROOT, 'store', 'airplay-test')
MTIME = 1792281600  # 2026-10-18, the same fixed time for every member


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def tgz(entries):
    """a gzipped ustar archive of (name, bytes, mode), owned 0:0, one mtime, reproducible"""
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


def pack_tool():
    c = json.load(open(os.path.join(TOOL_DIR, 'component.json')))
    entries, files, units = [], [], []
    for f in c['files']:
        data = open(os.path.join(TOOL_DIR, f['from']), 'rb').read()
        entries.append(('files/' + f['path'], data, int(f['mode'], 8)))
        files.append({'path': f['path'], 'mode': f['mode'], 'sha256': sha256(data)})
    for u in c['units']:
        entries.append(('units/' + u['name'], open(os.path.join(TOOL_DIR, u['from']), 'rb').read(), 0o644))
        units.append({'name': u['name']})
    manifest = {'id': c['id'], 'kind': 'tool', 'version': c['version'], 'title': c['title'], 'description': c['description'],
                'files': files, 'units': units, 'enable': c.get('enable', []), 'recmgr': c.get('recmgr', []), 'restart': c.get('restart', [])}
    for k in ('mguHmi', 'crashNames', 'check', 'activate', 'deactivate'):
        if k in c:
            manifest[k] = c[k]
    entries.append(('component.json', (json.dumps(manifest, indent=2) + '\n').encode(), 0o644))
    entries.sort(key=lambda e: e[0])
    name = '%s@%s.tgz' % (c['id'], c['version'])
    open(os.path.join(OUT, name), 'wb').write(tgz(entries))
    return c, name


def build_app():
    subprocess.run([sys.executable, os.path.join(ROOT, 'kit', 'tools', 'build.py'), APP], check=True, cwd=ROOT)
    spec = json.load(open(os.path.join(ROOT, 'apps', APP, 'app.json')))
    name = '%s@%s.tgz' % (APP, spec['version'])
    src = os.path.join(ROOT, 'dist', name)
    with tarfile.open(src) as tf:
        bad = [m for m in tf.getnames() if 'oap-sdk' in m]
    if bad:
        sys.exit('the package holds the oap-sdk: ' + bad[0])
    shutil.copy(src, os.path.join(OUT, name))
    return spec, name


def main():
    os.makedirs(OUT, exist_ok=True)
    for old in glob.glob(os.path.join(OUT, '*.tgz')):
        os.remove(old)
    tool, tool_art = pack_tool()
    spec, app_art = build_app()
    icon = APP + '.png'
    shutil.copy(os.path.join(ROOT, 'apps', APP, 'icon.png'), os.path.join(OUT, icon))

    def art(name):
        b = open(os.path.join(OUT, name), 'rb').read()
        return {'name': name, 'size': len(b), 'sha256': sha256(b), 'url': name}

    catalog = {'schema': 2, 'name': 'Aurel Marius AirPlay network test', 'components': [
        {'id': tool['id'], 'kind': 'tool', 'version': tool['version'], 'title': tool['title'], 'description': tool['description'],
         'author': 'aurelmarius', 'artifact': art(tool_art), 'requires': tool.get('requires', {}), 'uninstallable': True, 'mguHmi': ['ID7']},
        {'id': APP, 'kind': 'app', 'version': spec['version'], 'title': spec['title'], 'description': spec['description'],
         'author': 'aurelmarius', 'artifact': art(app_art), 'requires': {tool['id']: tool['version']}, 'uninstallable': True, 'mguHmi': ['ID7'],
         'icon': icon, 'iconSha256': sha256(open(os.path.join(OUT, icon), 'rb').read())},
    ]}
    with open(os.path.join(OUT, 'catalog.json'), 'w') as f:
        json.dump(catalog, f, indent=2)
        f.write('\n')
    for c in catalog['components']:
        print('%-22s %s %8d bytes' % (c['id'], c['version'], c['artifact']['size']))
    print('wrote ' + os.path.relpath(os.path.join(OUT, 'catalog.json'), ROOT))


if __name__ == '__main__':
    main()
