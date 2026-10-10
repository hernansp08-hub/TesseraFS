# Regenera las capturas de docs/img con la edición demo (datos de ejemplo) y Edge sin ventana.
# Uso: bun run ui:build ; pwsh scripts/capturas.ps1 [-Lang es] [-Out docs\img]
# La documentación está en español: por defecto las capturas se hacen con la interfaz en español (#lang=es).
param([string]$Lang = 'es', [string]$Out = '')
$ErrorActionPreference = 'Stop'
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$root = Split-Path -Parent $PSScriptRoot
$url = 'file:///' + ($root -replace '\\', '/') + '/packages/ui/dist/index.html'
$img = if ($Out) { $Out } else { Join-Path $root 'docs\img' }
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
  $hash = '#lang=' + $Lang + ($(if ($c[1]) { ',' + $c[1].TrimStart('#') } else { '' }))
  $a += $url + $hash
  Start-Process -FilePath $edge -ArgumentList $a -Wait -WindowStyle Hidden
  Write-Host "✓ $($c[0]).png"
}
