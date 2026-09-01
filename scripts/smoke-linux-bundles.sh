#!/bin/sh
# Structural smoke checks for the Linux bundles emitted by `npm run tauri build`.
set -eu

fail() {
  printf '%s\n' "error: $*" >&2
  exit 1
}

usage() {
  printf '%s\n' "Usage: $0 [--bundle-dir DIR]"
  printf '%s\n' "Defaults to src-tauri/target/release/bundle relative to this repository."
}

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd "$script_dir/.." && pwd)
bundle_dir=${BUNDLE_DIR:-"$repo_root/src-tauri/target/release/bundle"}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle-dir)
      [ "$#" -ge 2 ] || fail "--bundle-dir requires a directory"
      bundle_dir=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "Unknown argument: $1"
      ;;
  esac
done

[ -d "$bundle_dir" ] || fail "Bundle directory not found: $bundle_dir"
bundle_dir=$(CDPATH= cd "$bundle_dir" && pwd)

config="$repo_root/src-tauri/tauri.conf.json"
[ -f "$config" ] || fail "Tauri configuration not found: $config"
version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$config" | sed -n '1p')
[ -n "$version" ] || fail "Could not read the bundle version from $config"

expected_arch=${EXPECTED_ARCH:-amd64}
expected_elf_arch=${EXPECTED_ELF_ARCH:-x86-64}
deb_executable=usr/bin/convo
deb_desktop=usr/share/applications/Convo.desktop
deb_icon=usr/share/icons/hicolor/128x128/apps/convo.png
appimage_executable=usr/bin/convo
appimage_desktop=usr/share/applications/Convo.desktop
appimage_icon=usr/share/icons/hicolor/128x128/apps/convo.png

tar_supports_zstd() {
  case "$(tar --help 2>/dev/null)" in
    *--zstd*) return 0 ;;
    *) return 1 ;;
  esac
}

require_regular_executable() {
  executable_path=$1
  executable_description=$2

  if [ ! -f "$executable_path" ] || [ -L "$executable_path" ] || [ ! -x "$executable_path" ]; then
    fail "$executable_description is missing or not a regular executable: $executable_path"
  fi
}

require_expected_elf() {
  elf_path=$1
  elf_description=$2
  elf_info=$(file -b "$elf_path" 2>/dev/null) || fail "Could not inspect $elf_description architecture: $elf_path"

  case "$elf_info" in
    ELF\ 64-bit*"$expected_elf_arch"*) ;;
    *) fail "$elf_description is not $expected_elf_arch ELF: $elf_path ($elf_info)" ;;
  esac
}

read_deb_control_archive_member() {
  control_artifact=$1
  control_member=$2
  control_path=$3

  case "$control_member" in
    *.gz) ar p "$control_artifact" "$control_member" | tar -xOzf - "$control_path" 2>/dev/null ;;
    *.xz) ar p "$control_artifact" "$control_member" | tar -xOJf - "$control_path" 2>/dev/null ;;
    *.bz2) ar p "$control_artifact" "$control_member" | tar -xOjf - "$control_path" 2>/dev/null ;;
    *.zst) ar p "$control_artifact" "$control_member" | tar --zstd -xOf - "$control_path" 2>/dev/null ;;
    *) ar p "$control_artifact" "$control_member" | tar -xOf - "$control_path" 2>/dev/null ;;
  esac
}

read_deb_control_field() {
  artifact=$1
  field=$2

  control_member=$(ar t "$artifact" 2>/dev/null | while IFS= read -r member; do
    case "$member" in
      control.tar.*)
        printf '%s\n' "$member"
        break
        ;;
    esac
  done)
  [ -n "$control_member" ] || return 1

  case "$control_member" in
    *.zst)
      if ! tar_supports_zstd; then
        printf '%s\n' "error: Cannot inspect Debian control.tar.zst; installed tar lacks zstd support (--zstd): $artifact" >&2
        return 1
      fi
      ;;
  esac

  if ! control_contents=$(read_deb_control_archive_member "$artifact" "$control_member" control); then
    control_contents=$(read_deb_control_archive_member "$artifact" "$control_member" ./control) || return 1
  fi

  printf '%s\n' "$control_contents" | sed -n "s/^${field}:[[:space:]]*//p" | sed -n '1p'
}

check_deb_metadata() {
  artifact=$1

  if command -v dpkg-deb >/dev/null 2>&1; then
    actual_version=$(dpkg-deb -f "$artifact" Version 2>/dev/null) || fail "Could not read Debian metadata: $artifact"
    actual_arch=$(dpkg-deb -f "$artifact" Architecture 2>/dev/null) || fail "Could not read Debian metadata: $artifact"
  elif command -v ar >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    actual_version=$(read_deb_control_field "$artifact" Version) || fail "Could not read Debian control metadata with ar/tar: $artifact"
    actual_arch=$(read_deb_control_field "$artifact" Architecture) || fail "Could not read Debian control metadata with ar/tar: $artifact"
  else
    fail "Cannot inspect Debian metadata; require dpkg-deb or both ar and tar"
  fi

  [ "$actual_version" = "$version" ] || fail "Debian version metadata is '$actual_version', expected '$version': $artifact"
  [ "$actual_arch" = "$expected_arch" ] || fail "Debian architecture metadata is '$actual_arch', expected '$expected_arch': $artifact"
}

listed_path_present() {
  package_path_listing=$1
  package_path_target=$2

  case "
$package_path_listing
" in
    *"
$package_path_target
"*) return 0 ;;
  esac
  return 1
}

require_listed_package_path() {
  required_package_type=$1
  required_package_artifact=$2
  required_package_listing=$3
  required_package_path=$4
  required_package_path_type=$5

  if listed_path_present "$required_package_listing" "$required_package_path" || listed_path_present "$required_package_listing" "./$required_package_path"; then
    return 0
  fi

  fail "$required_package_type package is missing expected $required_package_path_type '$required_package_path': $required_package_artifact"
}

dpkg_listed_path_present() {
  dpkg_package_listing=$1
  dpkg_package_path=$2

  case "
$dpkg_package_listing
" in
    *" ./$dpkg_package_path
"*|*" $dpkg_package_path
"*) return 0 ;;
  esac
  return 1
}

require_dpkg_listed_package_path() {
  dpkg_required_artifact=$1
  dpkg_required_listing=$2
  dpkg_required_path=$3
  dpkg_required_path_type=$4

  if dpkg_listed_path_present "$dpkg_required_listing" "$dpkg_required_path"; then
    return 0
  fi

  fail "Debian package is missing expected $dpkg_required_path_type '$dpkg_required_path': $dpkg_required_artifact"
}

list_deb_data_paths_with_ar() {
  deb_data_artifact=$1

  deb_data_member=$(ar t "$deb_data_artifact" 2>/dev/null | while IFS= read -r member; do
    case "$member" in
      data.tar.*)
        printf '%s\n' "$member"
        break
        ;;
    esac
  done)
  [ -n "$deb_data_member" ] || return 1

  case "$deb_data_member" in
    *.gz) ar p "$deb_data_artifact" "$deb_data_member" | tar -tzf - 2>/dev/null ;;
    *.xz) ar p "$deb_data_artifact" "$deb_data_member" | tar -tJf - 2>/dev/null ;;
    *.bz2) ar p "$deb_data_artifact" "$deb_data_member" | tar -tjf - 2>/dev/null ;;
    *.zst)
      if ! tar_supports_zstd; then
        printf '%s\n' "error: Cannot inspect Debian data.tar.zst; installed tar lacks zstd support (--zstd): $deb_data_artifact" >&2
        return 1
      fi
      ar p "$deb_data_artifact" "$deb_data_member" | tar --zstd -tf - 2>/dev/null
      ;;
    *) ar p "$deb_data_artifact" "$deb_data_member" | tar -tf - 2>/dev/null ;;
  esac
}

extract_deb_data_with_ar() {
  deb_data_artifact=$1
  deb_data_destination=$2

  deb_data_member=$(ar t "$deb_data_artifact" 2>/dev/null | while IFS= read -r member; do
    case "$member" in
      data.tar.*)
        printf '%s\n' "$member"
        break
        ;;
    esac
  done)
  [ -n "$deb_data_member" ] || return 1

  case "$deb_data_member" in
    *.gz) ar p "$deb_data_artifact" "$deb_data_member" | tar -xzpf - -C "$deb_data_destination" 2>/dev/null ;;
    *.xz) ar p "$deb_data_artifact" "$deb_data_member" | tar -xJpf - -C "$deb_data_destination" 2>/dev/null ;;
    *.bz2) ar p "$deb_data_artifact" "$deb_data_member" | tar -xjpf - -C "$deb_data_destination" 2>/dev/null ;;
    *.zst)
      if ! tar_supports_zstd; then
        printf '%s\n' "error: Cannot extract Debian data.tar.zst; installed tar lacks zstd support (--zstd): $deb_data_artifact" >&2
        return 1
      fi
      ar p "$deb_data_artifact" "$deb_data_member" | tar --zstd -xpf - -C "$deb_data_destination" 2>/dev/null
      ;;
    *) ar p "$deb_data_artifact" "$deb_data_member" | tar -xpf - -C "$deb_data_destination" 2>/dev/null ;;
  esac
}

validate_deb_executable() (
  deb_executable_artifact=$1
  deb_temp_parent=${TMPDIR:-/tmp}
  deb_temp_dir=$(mktemp -d "$deb_temp_parent/convo-deb.XXXXXX") || fail "Could not create temporary directory to inspect Debian executable: $deb_executable_artifact"
  trap 'rm -rf "$deb_temp_dir"' 0 HUP INT TERM

  if command -v dpkg-deb >/dev/null 2>&1; then
    dpkg-deb -x "$deb_executable_artifact" "$deb_temp_dir" >/dev/null 2>&1 || fail "Could not extract Debian package contents with dpkg-deb: $deb_executable_artifact"
  else
    extract_deb_data_with_ar "$deb_executable_artifact" "$deb_temp_dir" || fail "Could not extract Debian data archive with ar/tar: $deb_executable_artifact"
  fi

  deb_executable_path=$deb_temp_dir/$deb_executable
  require_regular_executable "$deb_executable_path" "Debian package executable"
  require_expected_elf "$deb_executable_path" "Debian package executable"
)

check_deb_contents() {
  deb_contents_artifact=$1

  command -v file >/dev/null 2>&1 || fail "Cannot inspect Debian executable architecture; require file"
  command -v mktemp >/dev/null 2>&1 || fail "Cannot inspect Debian executable; require mktemp"

  if command -v dpkg-deb >/dev/null 2>&1; then
    deb_dpkg_listing=$(dpkg-deb -c "$deb_contents_artifact" 2>/dev/null) || fail "Could not list Debian package contents with dpkg-deb: $deb_contents_artifact"
    require_dpkg_listed_package_path "$deb_contents_artifact" "$deb_dpkg_listing" "$deb_executable" "executable"
    require_dpkg_listed_package_path "$deb_contents_artifact" "$deb_dpkg_listing" "$deb_desktop" "desktop entry"
    require_dpkg_listed_package_path "$deb_contents_artifact" "$deb_dpkg_listing" "$deb_icon" "icon"
  elif command -v ar >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    deb_data_paths=$(list_deb_data_paths_with_ar "$deb_contents_artifact") || fail "Could not list Debian data archive with ar/tar: $deb_contents_artifact"
    require_listed_package_path "Debian" "$deb_contents_artifact" "$deb_data_paths" "$deb_executable" "executable"
    require_listed_package_path "Debian" "$deb_contents_artifact" "$deb_data_paths" "$deb_desktop" "desktop entry"
    require_listed_package_path "Debian" "$deb_contents_artifact" "$deb_data_paths" "$deb_icon" "icon"
  else
    fail "Cannot inspect Debian package contents; require dpkg-deb or both ar and tar"
  fi

  validate_deb_executable "$deb_contents_artifact"
}

check_debs() {
  set -- "$bundle_dir"/deb/*.deb
  [ "$1" != "$bundle_dir/deb/*.deb" ] || fail "Missing Debian .deb artifact under $bundle_dir/deb"

  for artifact in "$@"; do
    [ -f "$artifact" ] && [ -s "$artifact" ] || fail "Debian artifact is missing or empty: $artifact"
    case "$artifact" in
      *"_${version}_${expected_arch}.deb") ;;
      *) fail "Debian artifact filename lacks version $version and architecture $expected_arch: $artifact" ;;
    esac
    check_deb_metadata "$artifact"
    check_deb_contents "$artifact"
  done
}

check_appimage_contents() (
  appimage_contents_artifact=$1

  command -v mktemp >/dev/null 2>&1 || fail "Cannot inspect AppImage contents; require mktemp and AppImage --appimage-extract support: $appimage_contents_artifact"
  appimage_temp_parent=${TMPDIR:-/tmp}
  appimage_temp_dir=$(mktemp -d "$appimage_temp_parent/convo-appimage.XXXXXX") || fail "Could not create temporary directory to inspect AppImage contents: $appimage_contents_artifact"
  trap 'rm -rf "$appimage_temp_dir"' 0 HUP INT TERM

  if ! (
    cd "$appimage_temp_dir"
    APPIMAGE_EXTRACT_AND_RUN=1 "$appimage_contents_artifact" --appimage-extract >/dev/null 2>&1
  ); then
    fail "Cannot inspect AppImage contents; require AppImage --appimage-extract support: $appimage_contents_artifact"
  fi

  appimage_contents_root=$appimage_temp_dir/squashfs-root
  [ -d "$appimage_contents_root" ] || fail "AppImage extraction did not produce squashfs-root: $appimage_contents_artifact"
  require_regular_executable "$appimage_contents_root/$appimage_executable" "AppImage executable"
  require_expected_elf "$appimage_contents_root/$appimage_executable" "AppImage executable"
  [ -f "$appimage_contents_root/$appimage_desktop" ] || fail "AppImage is missing expected desktop entry '$appimage_desktop': $appimage_contents_artifact"
  [ -f "$appimage_contents_root/$appimage_icon" ] || fail "AppImage is missing expected icon '$appimage_icon': $appimage_contents_artifact"
)

check_appimages() {
  command -v file >/dev/null 2>&1 || fail "Cannot inspect AppImage architecture; require file"

  set -- "$bundle_dir"/appimage/*.AppImage
  [ "$1" != "$bundle_dir/appimage/*.AppImage" ] || fail "Missing AppImage artifact under $bundle_dir/appimage"

  for artifact in "$@"; do
    [ -f "$artifact" ] && [ -s "$artifact" ] || fail "AppImage artifact is missing or empty: $artifact"
    case "$artifact" in
      *"_${version}_${expected_arch}.AppImage") ;;
      *) fail "AppImage filename lacks version $version and architecture $expected_arch: $artifact" ;;
    esac

    appimage_info=$(file -b "$artifact" 2>/dev/null) || fail "Could not inspect AppImage architecture: $artifact"
    case "$appimage_info" in
      *ELF*64-bit*"$expected_elf_arch"*) ;;
      *) fail "AppImage architecture is not $expected_elf_arch: $artifact ($appimage_info)" ;;
    esac
    check_appimage_contents "$artifact"
  done
}

command -v sha256sum >/dev/null 2>&1 || fail "Cannot write SHA256SUMS; require sha256sum"
check_debs
check_appimages

(
  cd "$bundle_dir"
  sha256sum deb/*.deb appimage/*.AppImage > SHA256SUMS
)
[ -s "$bundle_dir/SHA256SUMS" ] || fail "SHA256SUMS was not created: $bundle_dir/SHA256SUMS"
printf '%s\n' "Validated Linux bundles for version $version; wrote $bundle_dir/SHA256SUMS"
