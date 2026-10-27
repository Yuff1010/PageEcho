param([string]$Voice = 'Microsoft Huihui Desktop')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$taskFixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\cache\fixture-tools\reading-clips'))
[IO.Directory]::CreateDirectory($taskFixtureRoot) | Out-Null
$taskSpeaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $taskSpeaker.SelectVoice($Voice)
    $taskSpeaker.Rate = 0
    $taskFormat = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $taskPhrases = @('第十九章，故事从这里继续。', '窗外的风停了，屋里只剩下翻书的声音。', '他合上书，决定明天再出发。')
    for ($taskIndex = 0; $taskIndex -lt $taskPhrases.Length; $taskIndex++) {
        $taskSpeaker.SetOutputToWaveFile((Join-Path $taskFixtureRoot "$taskIndex.wav"), $taskFormat)
        $taskSpeaker.Speak($taskPhrases[$taskIndex])
        $taskSpeaker.SetOutputToNull()
    }
} finally { $taskSpeaker.Dispose() }
@'
import hashlib, json, pathlib, sys, wave
clips, output = map(pathlib.Path, sys.argv[1:])
phrases = ['第十九章，故事从这里继续。', '窗外的风停了，屋里只剩下翻书的声音。', '他合上书，决定明天再出发。']
pcm = bytearray(16000 * 2)
segments = []
for index, text in enumerate(phrases):
    with wave.open(str(clips / f'{index}.wav'), 'rb') as source:
        assert (source.getnchannels(), source.getsampwidth(), source.getframerate()) == (1, 2, 16000)
        data = source.readframes(source.getnframes())
    start = round(len(pcm) / 32)
    pcm.extend(data)
    end = round(len(pcm) / 32)
    segments.append(dict(id=f's{index + 1}', startMs=start, endMs=end, text=text))
    pcm.extend(bytes(16000 * 2 * 700 // 1000))
pcm.extend(bytes(16000 * 2))
audio = output / '第32集-伴读样本.wav'
with wave.open(str(audio), 'wb') as target:
    target.setnchannels(1); target.setsampwidth(2); target.setframerate(16000); target.writeframes(pcm)
document = dict(version=1, audioHash=hashlib.sha256(audio.read_bytes()).hexdigest(), kind='manual',
    coverage=[dict(startMs=0, endMs=segments[0]['endMs'] + 200),
              dict(startMs=segments[1]['startMs'] - 200, endMs=round(len(pcm) / 32))], segments=segments)
(output / 'reading-manual.json').write_text(json.dumps(document, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(document, ensure_ascii=False, indent=2))
'@ | python -X utf8 - $taskFixtureRoot $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'Reading fixture generation failed.' }
