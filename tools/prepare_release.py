#!/usr/bin/env python3
import glob
import hashlib
import json
import os
import subprocess
import sys
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKAGES_DIR = os.path.join(ROOT, 'packages')


def main():
    packages = sorted(glob.glob(os.path.join(PACKAGES_DIR, '*.tgz')))
    if not packages:
        print('No .tgz packages found in packages/', file=sys.stderr)
        sys.exit(1)

    apps_meta = {}
    components = []
    notes = [
        '### 🚗 BMW iDrive 7 Custom Apps\n',
        '#### Included Applications:\n'
    ]

    highest_version = [0, 0, 0]

    def tool_component(p):
        """a tool kit (component.json at the root), or None for an app package"""
        with tarfile.open(p, 'r:gz') as tf:
            try:
                return json.loads(tf.extractfile('component.json').read().decode('utf-8'))
            except KeyError:
                return None

    for p in packages:
        fname = os.path.basename(p)
        size = os.path.getsize(p)
        with open(p, 'rb') as f:
            sha = hashlib.sha256(f.read()).hexdigest()

        tool = tool_component(p)
        if tool:
            # a native tool (native/<id>/component.json): its requirements are the source folder's
            src = os.path.join(ROOT, 'native', tool['id'], 'component.json')
            requires = json.load(open(src)).get('requires', {}) if os.path.exists(src) else {}
            components.append({
                'id': tool['id'], 'kind': 'tool', 'version': tool['version'],
                'title': tool.get('title', tool['id']), 'description': tool.get('description', ''),
                'author': 'aurelmarius', 'mguHmi': tool.get('mguHmi', ['ID7']),
                'artifact': {'name': fname, 'size': size, 'sha256': sha, 'url': f'packages/{fname}'},
                'requires': requires, 'uninstallable': True,
            })
            notes.append(f"* **{tool.get('title', tool['id'])}** (`{fname}`, service) v{tool['version']}\n  {tool.get('description', '')}\n")
            continue

        with tarfile.open(p, 'r:gz') as tf:
            pkg_f = tf.extractfile('package/package.json')
            pkg = json.loads(pkg_f.read().decode('utf-8'))
            app_id = pkg['name']
            title = pkg.get('productName', app_id)
            desc = pkg.get('description', '')
            version = pkg.get('version', '1.0.0')
            hmi = pkg.get('mguHmi', ['ID7'])
            author = pkg.get('author', 'custom')

            try:
                v_parts = [int(x) for x in version.split('.')]
                if len(v_parts) == 3 and v_parts > highest_version:
                    highest_version = v_parts
            except Exception:
                pass

            apps_meta[app_id] = {
                'title': title,
                'description': desc,
                'author': author
            }

            icon_name = f'{app_id}.png'
            icon_path = os.path.join(ROOT, icon_name)
            comp = {
                'id': app_id,
                'kind': 'app',
                'version': version,
                'title': title,
                'description': desc,
                'mguHmi': hmi,
                'artifact': {
                    'name': fname,
                    'size': size,
                    'sha256': sha,
                    'url': f'packages/{fname}'
                },
                'uninstallable': True
            }
            if os.path.exists(icon_path):
                with open(icon_path, 'rb') as icf:
                    icon_sha = hashlib.sha256(icf.read()).hexdigest()
                apps_meta[app_id]['icon'] = icon_name
                apps_meta[app_id]['iconSha256'] = icon_sha
                comp['icon'] = icon_name
                comp['iconSha256'] = icon_sha
            # the tools an app needs (app.json "requires"): the Store installs them first
            spec_path = os.path.join(ROOT, 'apps', app_id, 'app.json')
            if os.path.exists(spec_path):
                req = json.load(open(spec_path, encoding='utf-8')).get('requires')
                if req:
                    comp['requires'] = req
            components.append(comp)
            notes.append(f'* **{title}** (`{fname}`) v{version}\n  {desc}\n')

    # every tool an app requires must be in this release
    ids = {c['id']: c for c in components}
    for c in components:
        for rid, rv in (c.get('requires') or {}).items():
            if rid.startswith('mgu-') or rid in ('cluster-render',):
                continue  # from mgu-store's (or Robert's) own sources
            if rid not in ids:
                sys.exit(f"{c['id']} requires {rid}, which is not in packages/")

    # 1. Write mgu-store.json (for car Store metadata)
    store_meta_path = os.path.join(ROOT, 'mgu-store.json')
    with open(store_meta_path, 'w', encoding='utf-8') as f:
        json.dump({'apps': apps_meta}, f, indent=2)
    print(f'Wrote {store_meta_path}')

    # 2. Write catalog.json (v2 store catalog)
    catalog_path = os.path.join(ROOT, 'catalog.json')
    with open(catalog_path, 'w', encoding='utf-8') as f:
        json.dump({'schema': 2, 'name': 'Aurel Marius BMW Apps', 'components': components}, f, indent=2)
    print(f'Wrote {catalog_path}')

    # 2b. The `catalog` release's catalog.json: the same, with absolute download URLs from that release
    # (the Store reads a Releases source through its `catalog` release when it has one; that is how a
    # tool, which a release asset cannot be, reaches the car). The workflow uploads it with every
    # package and icon to the `catalog` release.
    repo = os.environ.get('GITHUB_REPOSITORY', 'aurelmarius/bmw-apps')
    base = f'https://github.com/{repo}/releases/download/catalog/'
    rel = json.loads(json.dumps(components))
    for c in rel:
        c['artifact']['url'] = base + c['artifact']['name']
    rel_dir = os.path.join(ROOT, 'dist', 'catalog-release')
    os.makedirs(rel_dir, exist_ok=True)
    with open(os.path.join(rel_dir, 'catalog.json'), 'w', encoding='utf-8') as f:
        json.dump({'schema': 2, 'name': 'Aurel Marius BMW Apps', 'components': rel}, f, indent=2)
    print(f'Wrote dist/catalog-release/catalog.json ({base})')

    # 3. Write release notes
    notes_path = os.path.join(ROOT, 'release_notes.md')
    with open(notes_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(notes))
    print(f'Wrote {notes_path}')

    # 4. Determine Tag
    target_tag = os.environ.get('INPUT_TAG', '').strip()
    if not target_tag:
        # Check existing git tags
        try:
            res = subprocess.run(['git', 'tag', '-l'], stdout=subprocess.PIPE, text=True, check=True)
            existing_tags = set(res.stdout.split())
        except Exception:
            existing_tags = set()

        base_ver = f'v{highest_version[0]}.{highest_version[1]}.{highest_version[2]}'
        if base_ver not in existing_tags:
            target_tag = base_ver
        else:
            # increment patch until not found
            patch = highest_version[2]
            while True:
                patch += 1
                cand = f'v{highest_version[0]}.{highest_version[1]}.{patch}'
                if cand not in existing_tags:
                    target_tag = cand
                    break

    print(f'Computed Release Tag: {target_tag}')

    # Export to GitHub Actions environment
    github_output = os.environ.get('GITHUB_OUTPUT')
    if github_output:
        with open(github_output, 'a', encoding='utf-8') as f:
            f.write(f'tag={target_tag}\n')
            f.write(f'title=Release {target_tag}\n')


if __name__ == '__main__':
    main()
