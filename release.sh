#!/usr/bin/env bash
# Cut a release of the EmDash site image.
#
#   ./release.sh patch|minor|major [-p|--push]
#
# Bumps package.json + package-lock.json with `npm version`, which also creates the
# release commit and the vX.Y.Z tag. The tag is what triggers the GHCR image build
# (.github/workflows/image.yml); pushing the branch alone only publishes :edge.
#
# -p/--push   run `git push && git push --tags` after tagging
#
# Bump rules for this repo:
#   major  content/data action required (DB or storage adapter change, route/seed format change)
#   minor  template/theme/feature changes, adopting upstream template changes
#   patch  dependency bumps (emdash, astro, plugins) and fixes without model changes
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: ./release.sh patch|minor|major [-p|--push]

  patch   fixes, dependency bumps
  minor   new template/feature work
  major   breaking change: needs a content or data migration

  -p, --push   git push && git push --tags after tagging
  -h, --help   show this help
EOF
}

die() {
	printf 'release: %s\n' "$*" >&2
	exit 1
}

bump=''
push=false
for arg in "$@"; do
	case "$arg" in
	patch | minor | major) bump="$arg" ;;
	-p | --push) push=true ;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		printf 'release: unknown argument: %s\n\n' "$arg" >&2
		usage >&2
		exit 1
		;;
	esac
done

[ -n "$bump" ] || {
	usage >&2
	exit 1
}

command -v npm >/dev/null 2>&1 || die 'npm not found'
command -v git >/dev/null 2>&1 || die 'git not found'
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die 'not a git repository'

# npm version refuses to run on a dirty tree anyway; check up front for a clearer message.
if [ -n "$(git status --porcelain)" ]; then
	git status --short >&2
	die 'working tree is not clean; commit or stash first'
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != 'main' ]; then
	printf 'release: warning: on branch %s, not main\n' "$branch" >&2
fi

current="$(npm pkg get version | tr -d '"')"
printf 'release: current version %s, bumping %s\n' "$current" "$bump"

# Creates the version commit and the vX.Y.Z tag (matches the workflow's tag trigger).
npm version "$bump" -m 'chore(release): v%s'

version="$(npm pkg get version | tr -d '"')"
printf 'release: tagged v%s\n' "$version"

if [ "$push" = true ]; then
	git push
	git push --tags
	printf 'release: pushed v%s — the image workflow will publish %s\n' "$version" "$version"
else
	printf 'release: not pushed. Run:\n  git push && git push --tags\n' >&2
fi
