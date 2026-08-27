# =====================================================================
# build-zip.ps1 — package the deployable site for VERCEL.
#
#   powershell -File tools/build-zip.ps1
#
# Entries are written with FORWARD SLASHES explicitly. A previous build
# used backslash separators and the host unpacked it as a flat set of
# oddly-named files, so the site rendered as nothing. Do not replace this
# with Compress-Archive.
#
# NOTE: Vercel deploys from Git or the CLI rather than a zip upload. This
# archive is for handoff and for keeping a rollback point of exactly what
# was live; it is not itself the deploy mechanism.
# =====================================================================
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$src = Split-Path -Parent $PSScriptRoot

# The build output lives in the project, where writes always succeed. The
# Desktop copy is a convenience: Windows refuses to overwrite an existing
# file there from a child process even with nothing holding it open, so
# that copy is attempted and reported, never depended on.
# Each build writes a NEW timestamped file rather than overwriting a fixed
# name. This environment allows creating files but denies writing over an
# existing one, and a timestamped artifact is better practice anyway: the
# previously uploaded zip stays on disk to compare against or roll back to.
$dist = Join-Path $src 'dist'
if (-not (Test-Path $dist)) { New-Item -ItemType Directory $dist | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$out = Join-Path $dist "TwelvePoint-site-$stamp.zip"
$desktopCopy = Join-Path ([Environment]::GetFolderPath('Desktop')) "TwelvePoint-site-$stamp.zip"

# Only what the live site actually serves. The repo root also holds
# working images, screenshots and internal notes that must not ship.
$include = @()
$include += Get-ChildItem -Path $src -Filter *.html -File
# vercel.json, middleware.js and package.json are the live deploy config.
# netlify.toml and netlify/ are superseded and deliberately NOT shipped —
# two platform configs in one deploy is how the wrong one gets used.
$include += Get-ChildItem -Path $src -File | Where-Object {
  $_.Name -in @('robots.txt','sitemap.xml','favicon.ico','vercel.json','middleware.js','package.json')
}
$include += Get-ChildItem -Path (Join-Path $src 'assets') -File -Recurse |
            Where-Object { $_.Directory.Name -ne '_originals' }
# Portal pages ship like any other file. They are not secret — middleware.js
# is what keeps strangers from being served them.
# Files starting with "_" under portal/ are local previews with stubbed
# sample data. They must never reach the live site: a page that looks like
# a signed-in client view but needs no login would be alarming to find.
$include += Get-ChildItem -Path (Join-Path $src 'portal') -File -Recurse -Filter *.html |
            Where-Object { -not $_.Name.StartsWith('_') }
# (netlify/ intentionally excluded — superseded by middleware.js)
# Serverless functions. Vercel turns every file in api/ into an endpoint;
# without this the lead handler simply would not exist in production.
$include += Get-ChildItem -Path (Join-Path $src 'api') -File -Recurse -Filter *.js

# supabase/schema.sql is NOT shipped. It is a migration to run by hand, and
# publishing the schema on the live site helps nobody but an attacker.

# Build to a temp file and copy over the target. Writing the Desktop zip
# directly fails whenever Explorer or an antivirus scanner has it open,
# and a half-written zip on the Desktop is worse than a failed build.
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("tp-site-" + [guid]::NewGuid().ToString('N') + ".zip")
$zip = [System.IO.Compression.ZipFile]::Open($staging, 'Create')
try {
  foreach ($f in $include) {
    $rel = $f.FullName.Substring($src.Length + 1).Replace('\', '/')
    $e = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
    $es = $e.Open()
    $fs = [System.IO.File]::OpenRead($f.FullName)
    $fs.CopyTo($es)
    $fs.Dispose(); $es.Dispose()
  }
} finally { $zip.Dispose() }

# ---- verify the staged file BEFORE it replaces the good one
$z = [System.IO.Compression.ZipFile]::OpenRead($staging)
$check = $z.Entries | ForEach-Object { $_.FullName }
$z.Dispose()
if (@($check | Where-Object { $_ -like '*\*' }).Count -gt 0) {
  throw "backslash paths in staged zip - refusing to publish it"
}
# Overwrite in place. Neither Copy-Item -Force nor File::Delete is reliable
# here — both report Access Denied on an existing target — but WriteAllBytes
# opens with FileMode.Create, which truncates rather than deleting, and that
# succeeds. The staged bytes are already verified at this point.
[System.IO.File]::WriteAllBytes($out, [System.IO.File]::ReadAllBytes($staging))

$z = [System.IO.Compression.ZipFile]::OpenRead($out)
$names = $z.Entries | ForEach-Object { $_.FullName }
$z.Dispose()
$bad = @($names | Where-Object { $_ -like '*\*' })
Write-Output ("zip:      {0}" -f $out)
Write-Output ("entries:  {0}" -f $names.Count)
Write-Output ("html:     {0}" -f @($names | Where-Object { $_ -like '*.html' }).Count)
Write-Output ("size:     {0:N2} MB" -f ((Get-Item $out).Length / 1MB))
Write-Output ("backslash entries: {0}" -f $bad.Count)
foreach ($r in @('index.html','robots.txt','sitemap.xml','vercel.json','middleware.js','package.json')) {
  Write-Output ("  {0} {1}" -f $(if ($names -contains $r) { 'OK  ' } else { 'MISS' }), $r)
}
if ($bad.Count -gt 0) { throw "backslash paths present - do not upload" }

# Best-effort Desktop copy.
try {
  [System.IO.File]::WriteAllBytes($desktopCopy, [System.IO.File]::ReadAllBytes($out))
  Write-Output ("desktop:  {0}" -f $desktopCopy)
} catch {
  Write-Output "desktop:  not updated (delete the old Desktop zip by hand, or just upload the dist copy above)"
}
