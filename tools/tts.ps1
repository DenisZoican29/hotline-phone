# Renders every voice line in app/content.json to a raw WAV with Windows SAPI.
# Effects (pitch, phone filter, tape hiss) are applied afterwards by build-audio.js.
param(
  [string]$Content = "$PSScriptRoot\..\app\content.json",
  [string]$OutDir = "$PSScriptRoot\..\build\tts"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

New-Item -ItemType Directory -Force $OutDir | Out-Null
$data = Get-Content $Content -Raw -Encoding UTF8 | ConvertFrom-Json
$lines = @($data.messages | Where-Object { -not $_.silent }) + @($data.system)

$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)

foreach ($line in $lines) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice("Microsoft $($line.voice) Desktop")
  $synth.Rate = [int]$line.rate
  $file = Join-Path $OutDir "$($line.id).wav"
  $synth.SetOutputToWaveFile($file, $format)
  $synth.Speak($line.tts)
  $synth.Dispose()
  Write-Host "tts  $($line.id)"
}
