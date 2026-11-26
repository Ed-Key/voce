#!/bin/bash
# Usage: release-guard.sh TAG SHA
# Succeeds only when $GITHUB_REPOSITORY has no release (draft or published) for
# TAG and no git tag TAG pointing anywhere but SHA. Any other state, or a failed
# lookup, stops the release workflow. It never deletes or changes anything.
set -euo pipefail
TAG="$1"
SHA="$2"

MATCHES=$(gh api --paginate "repos/$GITHUB_REPOSITORY/releases" --jq ".[] | select(.tag_name == \"$TAG\") | .draft")
if grep -qx false <<<"$MATCHES"; then
  echo "::error::$TAG is already published. Bump the version in src-tauri/tauri.conf.json." >&2
  exit 1
fi
if [ -n "$MATCHES" ]; then
  echo "::error::A draft release for $TAG exists. Delete it on the Releases page, then run again." >&2
  exit 1
fi

# A missing tag is a 404; anything else that fails stops the run.
if REF=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$TAG" --jq '.object.sha' 2>"${TMPDIR:-/tmp}/release-guard.err"); then
  if [ "$REF" != "$SHA" ]; then
    echo "::error::Tag $TAG already points at another commit ($REF). Bump the version." >&2
    exit 1
  fi
elif ! grep -q "HTTP 404" "${TMPDIR:-/tmp}/release-guard.err"; then
  cat "${TMPDIR:-/tmp}/release-guard.err" >&2
  exit 1
fi
