#!/bin/sh
#
# mirb installer.
#
#   curl -fsSL https://mirb.dev/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version 0.2.0 --dir /usr/local/bin
#
# Written for POSIX sh, not bash. Piping into `sh` on Debian/Ubuntu runs this under
# dash, where arrays, [[ ]], `local` and ${var,,} are all syntax errors -- and a
# syntax error here surfaces *after* the user has already trusted the pipe, which is
# the worst possible moment to discover it. Keep this file boring.

set -eu

#-----------------------------------------------------------------------------
# CHANGE ME: the GitHub repository releases are published to.
# This is the only line that has to change if the project moves.
REPO="heysanil/mirrorball-cli"
#-----------------------------------------------------------------------------

BINARY="mirb"
# Long-form alias symlinked next to the binary. The project name, for people who
# remember it rather than the abbreviation.
ALIAS_NAME="mirrorball"
GITHUB="https://github.com"

# Every target `.bunli-releaser.yml` builds for macOS/Linux. Anything not on this
# list means we would be downloading a 404 page and chmod +x'ing it, so we refuse.
SUPPORTED="darwin-arm64 darwin-x64 linux-arm64 linux-x64"

# Set by main(); the trap needs them to exist even if we die early.
TMP=""
STAGE=""

#-- output ------------------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  C_RESET=$(printf '\033[0m')
  C_BOLD=$(printf '\033[1m')
  C_DIM=$(printf '\033[2m')
  C_RED=$(printf '\033[31m')
  C_YELLOW=$(printf '\033[33m')
  C_GREEN=$(printf '\033[32m')
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_YELLOW=''; C_GREEN=''
fi

# Progress goes to stderr so `| sh` output stays readable even when stdout is piped.
info() { printf '%s\n' "$*" >&2; }
step() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET" >&2; }
warn() { printf '  %swarning%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }

die() {
  printf '\n  %serror%s %s\n\n' "$C_RED" "$C_RESET" "$1" >&2
  if [ $# -gt 1 ]; then
    printf '  %s%s%s\n\n' "$C_DIM" "$2" "$C_RESET" >&2
  fi
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Install mirb, the instant SSH port forwarder.

  install.sh [--version <x.y.z>] [--dir <path>]

Options
  --version <x.y.z>   Install a specific release. Default: the latest release.
  --dir <path>        Install into <path>. Default: $HOME/.local/bin.
  --help              Show this message.

Environment
  MIRB_VERSION         Same as --version.
  MIRB_INSTALL_DIR     Same as --dir.
  NO_COLOR            Disable colored output.
USAGE
}

cleanup() {
  [ -n "$TMP" ] && rm -rf "$TMP"
  [ -n "$STAGE" ] && rm -f "$STAGE"
  # Explicit: the last test above returns 1 when STAGE is empty, and under `set -e`
  # a trap handler that returns non-zero would change the script's exit status.
  return 0
}
trap cleanup EXIT INT TERM HUP

#-- arguments ---------------------------------------------------------------

VERSION="${MIRB_VERSION:-}"
INSTALL_DIR="${MIRB_INSTALL_DIR:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#--version=}"; shift ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; INSTALL_DIR="$2"; shift 2 ;;
    --dir=*) INSTALL_DIR="${1#--dir=}"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage; die "unknown option: $1" ;;
  esac
done

[ -n "$INSTALL_DIR" ] || INSTALL_DIR="$HOME/.local/bin"

#-- platform ----------------------------------------------------------------

detect_platform() {
  uname_s=$(uname -s)
  uname_m=$(uname -m)

  case "$uname_s" in
    Darwin) OS="darwin" ;;
    Linux) OS="linux" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      die "this script does not run on Windows" \
          "Use PowerShell instead: irm https://mirb.dev/install.ps1 | iex"
      ;;
    *)
      die "unsupported operating system: $uname_s" \
          "mirb ships binaries for macOS and Linux. From source: bun install -g $BINARY"
      ;;
  esac

  case "$uname_m" in
    x86_64|amd64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)
      die "unsupported architecture: $uname_m" \
          "mirb ships x64 and arm64 builds. From source: bun install -g $BINARY"
      ;;
  esac

  PLATFORM="$OS-$ARCH"
  for candidate in $SUPPORTED; do
    [ "$candidate" = "$PLATFORM" ] && return 0
  done
  die "no mirb build exists for $PLATFORM" \
      "Supported: $SUPPORTED"
}

# Bun compiles against glibc, so an Alpine box will get a binary that cannot start.
# A warning rather than a refusal: gcompat makes it work often enough that a hard
# stop would be wrong.
warn_if_musl() {
  [ "$OS" = "linux" ] || return 0
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 || true) | grep -qi musl; then
    warn "this looks like a musl system; the release binary is built against glibc"
    warn "if mirb fails to start, install gcompat or build from source"
  fi
}

#-- fetching ----------------------------------------------------------------

detect_downloader() {
  if command -v curl >/dev/null 2>&1; then
    DL="curl"
  elif command -v wget >/dev/null 2>&1; then
    DL="wget"
  else
    die "neither curl nor wget is installed" \
        "Install one of them, e.g. apt-get install curl / brew install curl"
  fi
}

# download <url> <dest>
download() {
  if [ "$DL" = "curl" ]; then
    curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

# Resolve the tag behind /releases/latest by reading where GitHub redirects us.
# Deliberately not the JSON API: that is rate limited to 60 requests/hour per IP,
# which turns a shared CI runner into a flaky install.
resolve_latest_tag() {
  if [ "$DL" = "curl" ]; then
    resolved=$(curl -fsSL --proto '=https' -o /dev/null -w '%{url_effective}' \
      "$GITHUB/$REPO/releases/latest" 2>/dev/null || true)
  else
    resolved=$(wget -qS --max-redirect=0 --spider "$GITHUB/$REPO/releases/latest" 2>&1 \
      | awk 'tolower($1) == "location:" { print $2; exit }' || true)
  fi

  case "$resolved" in
    */tag/*) printf '%s\n' "${resolved##*/tag/}" ;;
    *) return 1 ;;
  esac
}

#-- verification ------------------------------------------------------------

# There is deliberately no --skip-checksum escape hatch. A flag that turns
# verification off is a flag an attacker can talk a user into typing.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{ print $NF }'
  else
    return 1
  fi
}

#-- PATH advice -------------------------------------------------------------

on_path() {
  case ":${PATH:-}:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

print_path_help() {
  export_line="export PATH=\"$INSTALL_DIR:\$PATH\""

  case "${SHELL##*/}" in
    zsh) rc_file="$HOME/.zshrc" ;;
    # macOS Terminal starts bash as a *login* shell, which reads .bash_profile and
    # never .bashrc. Writing to the wrong one is the classic "I added it and nothing
    # happened" bug report.
    bash) if [ "$OS" = "darwin" ]; then rc_file="$HOME/.bash_profile"; else rc_file="$HOME/.bashrc"; fi ;;
    fish) rc_file="$HOME/.config/fish/config.fish"; export_line="fish_add_path $INSTALL_DIR" ;;
    ksh) rc_file="$HOME/.kshrc" ;;
    *) rc_file="$HOME/.profile" ;;
  esac

  printf '\n  %s%s is not on your PATH.%s Add it:\n\n' "$C_YELLOW" "$INSTALL_DIR" "$C_RESET" >&2
  printf "    echo '%s' >> %s\n" "$export_line" "$rc_file" >&2
  printf '    exec %s\n' "${SHELL:-sh}" >&2
}

#-- main --------------------------------------------------------------------

detect_platform
detect_downloader
warn_if_musl

printf '\n  %sInstalling mirb%s %s(%s)%s\n\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$PLATFORM" "$C_RESET" >&2

if [ -n "$VERSION" ]; then
  # Accept both `1.2.3` and `v1.2.3`; tags carry the v, filenames do not.
  TAG="v${VERSION#v}"
else
  step "resolving latest release"
  TAG=$(resolve_latest_tag || true)
  [ -n "$TAG" ] || die "could not determine the latest mirb release" \
    "Pass an explicit version: install.sh --version 0.1.0"
fi

BASE_URL="$GITHUB/$REPO/releases/download/$TAG"

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t mirb)
CHECKSUMS="$TMP/checksums.txt"

step "fetching $TAG"
download "$BASE_URL/checksums.txt" "$CHECKSUMS" \
  || die "no release assets found for $TAG" "Looked in $BASE_URL"

# The manifest is the source of truth for the asset name. Deriving the filename from
# the tag would bake in an assumption about whether the releaser keeps the `v`
# prefix; reading it back removes the guess and fails loudly if naming ever changes.
ASSET=$(awk -v sfx="-$PLATFORM.tar.gz" '
  {
    f = $2
    sub(/^\*/, "", f)
    if (length(f) > length(sfx) && substr(f, length(f) - length(sfx) + 1) == sfx) {
      print f
      exit
    }
  }
' "$CHECKSUMS")

[ -n "$ASSET" ] || die "release $TAG has no build for $PLATFORM" \
  "See $GITHUB/$REPO/releases/tag/$TAG"

EXPECTED=$(awk -v want="$ASSET" '
  { f = $2; sub(/^\*/, "", f); if (f == want) { print tolower($1); exit } }
' "$CHECKSUMS")

[ -n "$EXPECTED" ] || die "checksums.txt has no entry for $ASSET"

step "downloading $ASSET"
download "$BASE_URL/$ASSET" "$TMP/$ASSET" || die "download failed: $BASE_URL/$ASSET"

step "verifying checksum"
# Two statements, not one pipeline: a pipeline reports `tr`'s status, so a missing
# hash tool would be reported as a checksum mismatch instead of what it is.
ACTUAL=$(sha256_of "$TMP/$ASSET") \
  || die "no sha256 tool found (needs sha256sum, shasum or openssl)" \
         "mirb will not install a binary it cannot verify."
ACTUAL=$(printf '%s' "$ACTUAL" | tr 'ABCDEF' 'abcdef')

if [ "$ACTUAL" != "$EXPECTED" ]; then
  die "checksum mismatch for $ASSET -- refusing to install" \
      "expected $EXPECTED, got $ACTUAL"
fi

step "extracting"
mkdir -p "$TMP/x"
tar -xzf "$TMP/$ASSET" -C "$TMP/x" || die "could not extract $ASSET"

# Archive root first, because that is the layout the releaser produces today and it
# keeps the common path free of any dependency on find(1). The recursive search is
# only a safety net for a future release that nests the binary in a directory.
if [ -f "$TMP/x/$BINARY" ]; then
  BIN_SRC="$TMP/x/$BINARY"
else
  BIN_SRC=$(find "$TMP/x" -type f -name "$BINARY" 2>/dev/null | head -n 1)
fi
[ -n "$BIN_SRC" ] || die "no '$BINARY' binary inside $ASSET" \
  "The release archive is not laid out the way this installer expects."

mkdir -p "$INSTALL_DIR" || die "could not create $INSTALL_DIR"
[ -w "$INSTALL_DIR" ] || die "$INSTALL_DIR is not writable" \
  "Try: install.sh --dir \"\$HOME/.local/bin\"   (or re-run with sudo)"

# Stage then rename. Writing straight over the target gives ETXTBSY ("Text file
# busy") on Linux if an mirb session is running; rename(2) is atomic and leaves the
# running process on the old inode.
STAGE="$INSTALL_DIR/.$BINARY.$$"
cp "$BIN_SRC" "$STAGE"
chmod 755 "$STAGE"
mv -f "$STAGE" "$INSTALL_DIR/$BINARY"
STAGE=""

# Harmless if the attribute was never set; saves a confusing Gatekeeper prompt when
# it was.
[ "$OS" = "darwin" ] && xattr -d com.apple.quarantine "$INSTALL_DIR/$BINARY" 2>/dev/null || true

# The project is "mirrorball"; the command is `mirb` because that is what you type a
# dozen times a day. Install the long name as a symlink so either works, and so a user
# who only remembers the project name is not stuck. Best-effort: a filesystem without
# symlinks, or an existing unrelated `mirrorball`, must not fail the install of `mirb`.
ALIAS="$INSTALL_DIR/$ALIAS_NAME"
if [ ! -e "$ALIAS" ] || [ -L "$ALIAS" ]; then
  ln -sf "$BINARY" "$ALIAS" 2>/dev/null || true
fi

printf '\n  %smirb %s installed%s\n\n' "$C_GREEN" "${TAG#v}" "$C_RESET" >&2
printf '    %s%s/%s%s\n' "$C_DIM" "$INSTALL_DIR" "$BINARY" "$C_RESET" >&2
[ -L "$INSTALL_DIR/$ALIAS_NAME" ] && \
  printf '    %s%s/%s -> %s%s\n' "$C_DIM" "$INSTALL_DIR" "$ALIAS_NAME" "$BINARY" "$C_RESET" >&2

if on_path "$INSTALL_DIR"; then
  printf '\n  %sGet started%s\n\n' "$C_BOLD" "$C_RESET" >&2
  printf '    mirb 10.0.0.7 3000        %sforward a port%s\n' "$C_DIM" "$C_RESET" >&2
  printf '    mirb ls                   %slist background sessions%s\n' "$C_DIM" "$C_RESET" >&2
  printf '    mirb --help\n' >&2
else
  print_path_help
fi

printf '\n' >&2
