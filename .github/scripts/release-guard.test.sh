#!/bin/bash
# Checks release-guard.sh against a gh stub that applies the script's real --jq
# filter to raw release fixtures (so the tag filter is exercised) and answers
# tag lookups. Run: bash .github/scripts/release-guard.test.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
STUB="$(mktemp -d)"
trap 'rm -rf "$STUB"' EXIT
cat > "$STUB/gh" <<'EOF'
#!/bin/bash
# $GH_RELEASES: JSON array of releases, or "fail". $GH_TAG: commit sha, "none" (404) or "fail".
path="" jq_expr=""
while [ $# -gt 0 ]; do
  case "$1" in --jq) jq_expr="$2"; shift 2 ;; --paginate|api) shift ;; *) path="$1"; shift ;; esac
done
case "$path" in
  */releases)
    [ "$GH_RELEASES" = fail ] && { echo "HTTP 502" >&2; exit 1; }
    printf '%s' "$GH_RELEASES" | jq -r "$jq_expr" ;;
  */git/ref/tags/*)
    case "$GH_TAG" in
      none) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
      fail) echo "gh: Server Error (HTTP 500)" >&2; exit 1 ;;
      *) printf '{"object":{"sha":"%s"}}' "$GH_TAG" | jq -r "$jq_expr" ;;
    esac ;;
  *) echo "unexpected path $path" >&2; exit 2 ;;
esac
EOF
chmod +x "$STUB/gh"
export GITHUB_REPOSITORY=owner/repo PATH="$STUB:$PATH" TMPDIR="$STUB"

OTHER='[{"id":1,"tag_name":"v0.9.0","draft":false},{"id":2,"tag_name":"v1.0.0-beta","draft":true}]'
fails=0
check() { # name, releases json, tag answer, expected exit
  GH_RELEASES="$2" GH_TAG="$3" bash "$HERE/release-guard.sh" v1.0.0 abc123 >/dev/null 2>&1; code=$?
  if [ "$code" = "$4" ]; then echo "pass: $1"; else echo "FAIL: $1 (exit $code, wanted $4)"; fails=1; fi
}
check "fresh version"                 "$OTHER"                                        none   0
check "other tags only, not matched"  '[{"id":3,"tag_name":"v1.0.00","draft":false}]' none   0
check "tag already at this commit"    "$OTHER"                                        abc123 0
check "published"                     '[{"id":4,"tag_name":"v1.0.0","draft":false}]'  none   1
check "draft exists"                  '[{"id":5,"tag_name":"v1.0.0","draft":true}]'   none   1
check "tag at another commit"         "$OTHER"                                        def456 1
check "release lookup fails"          fail                                            none   1
check "tag lookup fails"              "$OTHER"                                        fail   1
exit $fails
