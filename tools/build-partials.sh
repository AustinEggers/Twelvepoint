#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Stamps the shared partials into every page between their markers.
#
#   partials/footer.html  ->  <!-- FOOTER:START --> ... <!-- FOOTER:END -->
#   partials/dialog.html  ->  <!-- DIALOG:START --> ... <!-- DIALOG:END -->
#
# WHY A SCRIPT AND NOT A JS INCLUDE
# The footer carries the TREC-required brokerage disclosures and the two
# statutory notice links. Injected by JavaScript they would vanish wherever
# the script failed to run and would be invisible to crawlers. So the shared
# markup is real HTML in every file and this script keeps the copies identical.
#
# USAGE
#   bash tools/build-partials.sh          # stamp every page
#   bash tools/build-partials.sh --check  # verify only, exit 1 on drift
#
# ADDING A NEW PAGE
# Add the marker pairs where each partial belongs, then re-run. A page with no
# DIALOG markers gets them inserted automatically just above the footer.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

# idx-wrapper.html is re-served by IDX Broker from THEIR domain, so relative
# paths in it would 404. Every relative target the footer partial uses:
REL_PATHS="/assets/logo-cream.png /listings.html /buyers.html /home-value.html /team.html /index.html#standard /blog.html /join.html /login.html"
DOMAIN="https://REPLACE-WITH-YOUR-DOMAIN"

stamp() {                     # stamp <file> <partial> <TAG>
  local f="$1" partial="$2" tag="$3"
  local body tmp
  body="$(mktemp)"; tmp="$(mktemp)"
  cp "$partial" "$body"

  if [ "$f" = "idx-wrapper.html" ]; then
    for p in $REL_PATHS; do
      sed -i "s|\"$p\"|\"$DOMAIN$p\"|g" "$body"
    done
  fi

  awk -v bodyfile="$body" -v tag="$tag" '
    $0 ~ (tag ":START") { print; while ((getline line < bodyfile) > 0) print line; skip=1; next }
    $0 ~ (tag ":END")   { skip=0 }
    !skip { print }
  ' "$f" > "$tmp"

  if cmp -s "$f" "$tmp"; then
    rm -f "$tmp" "$body"; return 1        # unchanged
  fi
  if [ "$CHECK" = "1" ]; then
    rm -f "$tmp" "$body"; return 2        # would change
  fi
  mv "$tmp" "$f"; rm -f "$body"; return 0 # stamped
}

drift=0
# Root pages plus the signed-in portal pages. The footer partial uses
# root-absolute paths precisely so the same markup works at both depths.
for f in *.html portal/*/*.html; do
  changed=""

  # Marketing pages all carry the contact dialog; add its markers above the
  # footer if absent. Portal pages are excluded — they are signed-in surfaces
  # with the agent's direct contact already on them, so the "start a
  # conversation" lead form there would be dead markup.
  case "$f" in portal/*) dialog_ok=0 ;; *) dialog_ok=1 ;; esac
  if [ "$dialog_ok" = "1" ] && ! grep -q 'DIALOG:START' "$f" && grep -q 'FOOTER:START' "$f"; then
    if [ "$CHECK" = "1" ]; then
      echo "  DRIFT     $f (no DIALOG markers)"; drift=1
    else
      awk '
        /FOOTER:START/ && !done {
          print "<!-- DIALOG:START — generated from partials/dialog.html by tools/build-partials.sh. Do not edit here. -->"
          print "<!-- DIALOG:END -->"
          done=1
        }
        { print }
      ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
      changed="markers "
    fi
  fi

  for pair in "partials/footer.html:FOOTER" "partials/dialog.html:DIALOG"; do
    partial="${pair%%:*}"; tag="${pair##*:}"
    [ -f "$partial" ] || continue
    grep -q "$tag:START" "$f" || continue
    set +e; stamp "$f" "$partial" "$tag"; rc=$?; set -e
    case $rc in
      0) changed="$changed$tag " ;;
      2) echo "  DRIFT     $f ($tag)"; drift=1 ;;
    esac
  done

  if [ -n "$changed" ]; then echo "  stamped   $f  [$changed]"; else echo "  ok        $f"; fi
done

if [ "$CHECK" = "1" ] && [ "$drift" = "1" ]; then
  echo "drift detected — run: bash tools/build-partials.sh"; exit 1
fi
echo "done"
