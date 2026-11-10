#!/usr/bin/env bash
# retire_older_releases.sh <tag> - after <tag> is published: every other published release becomes a
# pre-release, and <tag> the latest.
#
# mgu-store reads every published release of a Releases source (pre-releases and drafts not), so an
# older release still carrying an app since renamed or moved shows it in the Store a second time.
# Each release carries every package in packages/, so the newest one is all the Store needs; the
# older ones stay as they were (assets, notes), only out of the Store's sight.
# The `catalog` release (the Store's catalog.json) is never retired.
# Needs GH_TOKEN and GH_REPO (as the workflows set them).
set -euo pipefail
KEEP="${1:?usage: retire_older_releases.sh <published tag>}"

# never retire everything: the release to keep must itself be published
state=$(gh release view "$KEEP" --json isDraft,isPrerelease --jq '"\(.isDraft) \(.isPrerelease)"')
if [ "$state" != "false false" ]; then
    echo "$KEEP is not a published release (draft, prerelease: $state): nothing retired" >&2
    exit 1
fi

gh release list --limit 200 --json tagName,isDraft,isPrerelease \
    --jq '.[] | select(.isDraft == false and .isPrerelease == false) | .tagName' |
while read -r t; do
    [ "$t" = "$KEEP" ] && continue
    # the Store's catalog release is read as the source's catalog: never retired
    [ "$t" = "catalog" ] && continue
    echo "retiring $t"
    gh release edit "$t" --prerelease
done
gh release edit "$KEEP" --latest
gh release list --limit 10
