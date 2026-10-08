# Regenera las capturas de docs/img con la edición demo (datos de ejemplo) y Edge sin ventana.
# Uso: bun run ui:build ; pwsh scripts/capturas.ps1
$ErrorActionPreference = 'Stop'
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$root = Split-Path -Parent $PSScriptRoot
$url = 'file:///' + ($root -replace '\\', '/') + '/packages/ui/dist/index.html'
$img = Join-Path $root 'docs\img'
$prof = Join-Path $env:TEMP 'tessera-capturas'
New-Item -ItemType Directory -Force $img | Out-Null

# nombre, enlace directo, presupuesto de tiempo virtual (ms), tema oscuro, sin animaciones
$capturas = @(
  @('principal', '', 9000, $true, $false),
  @('limpieza', '#limpieza', 12000, $true, $false),
  @('antiguedad', '#antiguedad', 9000, $true, $false),
  @('relieve-extension', '#relieve,extension', 9000, $true, $false),
  @('archivos', '#archivos', 10000, $true, $false),
  @('guia', '#guia', 9000, $true, $false),
  @('claro', '', 9000, $false, $false),
  @('escaneo', '', 1200, $true, $true)   # a mitad de escaneo; sin transiciones para que la barra cuadre
)
foreach ($c in $capturas) {
  $a = @('--headless=new', '--disable-gpu', '--hide-scrollbars', "--user-data-dir=`"$prof`"", '--window-size=1600,940',
    "--virtual-time-budget=$($c[2])", "--screenshot=`"$(Join-Path $img ($c[0] + '.png'))`"")
  if ($c[3]) { $a += '--force-dark-mode' }
  if ($c[4]) { $a += '--force-prefers-reduced-motion' }
  $a += $url + $c[1]
  Start-Process -FilePath $edge -ArgumentList $a -Wait -WindowStyle Hidden
  Write-Host "✓ $($c[0]).png"
}
