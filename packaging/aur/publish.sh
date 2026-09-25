#!/usr/bin/env bash
# Publishes one of the AUR packages in packaging/aur: fills in pkgver (and checksums), regenerates .SRCINFO,
# copies the files into a checkout of the AUR repo, shows the diff and pushes it.
#
#   packaging/aur/publish.sh [-y] [-n] [-v version] <podium-git|podium|podium-bin> [commit message]
#     -y  don't ask before pushing
#     -n  dry run: prepare and show the diff, but don't commit or push
#     -v  release to publish (podium, podium-bin); default: the version in package.json.
#         Its GitHub Release (tag v<version>) must exist.
#
# podium-git only needs publishing when its PKGBUILD changes; AUR helpers pick up new commits themselves.
#
# Environment: AUR_DIR (checkout of the AUR repo, default ~/aur/<package>),
#              AUR_SSH_KEY (default ~/.ssh/id_ed25519_aur, used when present).
set -euo pipefail

usage() { sed -n '5,10p' "$0" >&2; exit 2; }
die() { echo "error: $*" >&2; exit 1; }
say() { echo "==> $*"; }

yes=0 dry=0 version=''
while getopts ynv: opt; do
  case "$opt" in
    y) yes=1 ;;
    n) dry=1 ;;
    v) version="${OPTARG#v}" ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))
pkg="${1:-}"
message="${2:-}"
case "$pkg" in podium-git | podium | podium-bin) ;; *) usage ;; esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/$pkg"
repo="$(cd "$here/../.." && pwd)"
aur_dir="${AUR_DIR:-$HOME/aur/$pkg}"
aur_remote="${AUR_REMOTE:-ssh://aur@aur.archlinux.org/$pkg.git}"
key="${AUR_SSH_KEY:-$HOME/.ssh/id_ed25519_aur}"
files=(PKGBUILD .SRCINFO .gitignore)

# Only AUR operations use the AUR key; GitHub keeps using the normal SSH setup.
aur_git() {
  if [[ -f "$key" ]]; then
    GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes" git "$@"
  else
    git "$@"
  fi
}

# Leaves the AUR checkout as it was, so the next run can pull cleanly.
discard() {
  git -C "$aur_dir" reset -q
  git -C "$aur_dir" checkout -q -- . 2>/dev/null || true
  git -C "$aur_dir" clean -fq -- "${files[@]}"
}

field() { sed -n "s/^$1=//p" "$2"; }

if [[ -d "$aur_dir/.git" ]]; then
  say "Updating $aur_dir"
  aur_git -C "$aur_dir" fetch -q origin || die "could not fetch $aur_remote"
  # Until the first push the package doesn't exist and there's nothing to merge.
  if git -C "$aur_dir" rev-parse -q --verify origin/master >/dev/null; then
    git -C "$aur_dir" merge -q --ff-only origin/master || die "could not update $aur_dir; resolve it by hand"
  fi
else
  say "Cloning $aur_remote into $aur_dir"
  mkdir -p "$(dirname "$aur_dir")"
  # Cloning a package that doesn't exist yet gives an empty repo; the first push creates it.
  aur_git -c init.defaultBranch=master clone -q "$aur_remote" "$aur_dir" ||
    die "could not clone $aur_remote (is your SSH key on your AUR account?)"
fi
published="$([[ -f "$aur_dir/PKGBUILD" ]] && field pkgver "$aur_dir/PKGBUILD" || true)"

if [[ "$pkg" == podium-git ]]; then
  # AUR users build from the git source, so it has to be reachable without credentials (no credential
  # helper, which would quietly log in with the GitHub token).
  git_url="$(sed -n "s|^source=(\"[^:]*::git+\([^\"#]*\).*|\1|p" "$src/PKGBUILD")"
  [[ -n "$git_url" ]] || die "could not read the git source from PKGBUILD"
  GIT_TERMINAL_PROMPT=0 git -c credential.helper= ls-remote --exit-code "$git_url" HEAD >/dev/null 2>&1 ||
    die "$git_url is not publicly readable; AUR users could not build the package"

  # pkgver is informational for -git packages (makepkg recomputes it), but keep it matching what users
  # get: the default branch as pushed, not the local checkout.
  branch="$(git -C "$repo" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  branch="${branch#origin/}"
  branch="${branch:-master}"
  git -C "$repo" fetch -q origin "$branch"
  version="$(git -C "$repo" show "origin/$branch:package.json" | sed -n 's/^  "version": "\(.*\)",$/\1/p')"
  [[ -n "$version" ]] || die "could not read the version from package.json on origin/$branch"
  pkgver="$version.r$(git -C "$repo" rev-list --count "origin/$branch").g$(git -C "$repo" rev-parse --short=7 "origin/$branch")"
  if [[ -n "$(git -C "$repo" log --oneline "origin/$branch..HEAD")" ]]; then
    echo "warning: local commits not on origin/$branch are not in the package until you push them" >&2
  fi
  sed -i "s/^pkgver=.*/pkgver=$pkgver/" "$src/PKGBUILD"
else
  version="${version:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$repo/package.json")}"
  [[ -n "$version" ]] || die "could not read the version from package.json"
  pkgver="${version//-/_}" # pacman versions can't contain dashes
  # A new release starts again at pkgrel 1; republishing the same one keeps the pkgrel in the PKGBUILD,
  # so bump that by hand for packaging fixes.
  [[ "$published" != "$pkgver" ]] && sed -i "s/^pkgrel=.*/pkgrel=1/" "$src/PKGBUILD"
  sed -i "s/^pkgver=.*/pkgver=$pkgver/" "$src/PKGBUILD"
  say "Downloading the v$version release to checksum it"
  (cd "$src" && updpkgsums >/dev/null 2>&1) ||
    die "could not download the v$version release; is it published on GitHub?"
fi

(cd "$src" && makepkg --printsrcinfo >.SRCINFO)
say "$pkg $pkgver-$(field pkgrel "$src/PKGBUILD")"

for f in "${files[@]}"; do cp "$src/$f" "$aur_dir/$f"; done
git -C "$aur_dir" add "${files[@]}"
if git -C "$aur_dir" diff --cached --quiet; then
  say "The AUR already has this version; nothing to push"
  exit 0
fi
git -C "$aur_dir" --no-pager diff --cached --stat
git -C "$aur_dir" --no-pager diff --cached -- PKGBUILD

if ((dry)); then
  discard
  say "Dry run: nothing committed or pushed"
  exit 0
fi
if ((!yes)); then
  read -rp "Push this to the AUR? [y/N] " answer
  [[ "$answer" == [yY]* ]] || { discard; echo "Cancelled"; exit 1; }
fi

if [[ -z "$message" ]]; then
  git -C "$aur_dir" rev-parse -q --verify HEAD >/dev/null && message="Update to $pkgver-$(field pkgrel "$src/PKGBUILD")" || message="Initial import: $pkg $pkgver"
fi
git -C "$aur_dir" commit -q -m "$message"
# The AUR only accepts pushes to master.
aur_git -C "$aur_dir" push -q origin HEAD:master
say "Published: https://aur.archlinux.org/packages/$pkg"
