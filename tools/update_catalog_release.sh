#!/bin/sh
# update_catalog_release.sh <tag> - the `catalog` release, from the release <tag> just published.
#
# The Store reads a Releases source through its `catalog` release when it has one: that is how a tool (a native
# service such as myAirPlay's, which a release asset cannot be) reaches the car. Once it exists, the Store sees this
# repository's apps through it alone, so it follows the published release, never a draft: it is made from that
# release's own packages and icons (catalog.json with absolute URLs into the `catalog` release), and the assets
# no longer listed are removed. Run by publish-release.yml and retire-on-publish.yml; the `catalog` release is
# never retired (retire_older_releases.sh).
set -eu
TAG="$1"
rm -f packages/*.tgz
gh release download "$TAG" --pattern '*.tgz' --dir packages --clobber
gh release download "$TAG" --pattern '*.png' --dir . --clobber || true
INPUT_TAG="$TAG" python3 tools/prepare_release.py
if ! gh release view catalog >/dev/null 2>&1; then
    gh release create catalog --title "Store catalog" --latest=false \
        --notes "The Store's catalog for this repository (catalog.json): every app and service of the latest published release. Updated when a release is published; never retired."
fi
gh release upload catalog dist/catalog-release/catalog.json packages/*.tgz ./*.png --clobber
keep=$(ls packages/*.tgz ./*.png | xargs -n1 basename; echo catalog.json)
gh release view catalog --json assets --jq '.assets[].name' | while read -r a; do
    echo "$keep" | grep -qxF "$a" || { echo "removing old asset $a"; gh release delete-asset catalog "$a" --yes; }
done
gh release view catalog --json assets --jq '.assets[].name'
