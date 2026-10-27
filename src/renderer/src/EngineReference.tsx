import { engineReference } from '../../shared/engine-reference'
import type { SubtitlePreparation } from '../../shared/transcription'
import { SettingsDisclosureSummary } from './SettingsDisclosure'

export function EngineReference({ device }: { device: SubtitlePreparation['device'] }) {
  return (
    <details className="engine-reference settings-disclosure">
      <SettingsDisclosureSummary
        title="试用引擎参考"
        description="查看固定样本的对比与适用范围"
        status={device === 'cpu' ? 'CPU' : 'NVIDIA GPU'}
      />
      <div className="settings-disclosure-body">
        <p>
          已有的这些中文参考片段中，Paraformer 的字符编辑数较少，可先作为试用选项。
          引擎仍由你明确选择，本书效果请试听校对。
        </p>
        <p className="tools-hint">
          以下为 {device === 'cpu' ? 'CPU' : 'NVIDIA GPU'} 的已有实测，参考日期{' '}
          {engineReference.evidenceDate}。 每个引擎均完成表中全部固定样本。
        </p>
        <table>
          <thead>
            <tr>
              <th>人工参考材料</th>
              <th>参考字数</th>
              <th>Paraformer CER</th>
              <th>WhisperX CER</th>
            </tr>
          </thead>
          <tbody>
            {engineReference.datasets.map((dataset) => (
              <tr key={dataset.id}>
                <th scope="row">
                  {dataset.label}
                  <small>
                    {dataset.source} · {dataset.samples} 段
                  </small>
                </th>
                <td>{dataset.referenceCharacters}</td>
                {(['paraformer', 'whisperx'] as const).map((engine) => {
                  const profile = dataset.profiles.find(
                    (row) => row.engine === engine && row.device === device,
                  )!
                  return (
                    <td key={engine}>
                      {(profile.cer * 100).toFixed(2)}%
                      <small>
                        {profile.editDistance}/{dataset.referenceCharacters} 编辑
                      </small>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="tools-hint">
          CER 是字符编辑数除以参考字数，保留数字写法差异，不能直接换算成“听错内容”的比例。
          干声材料只有两位说话人的短词短句，连续材料来自同一场会议，影视材料也很短；训练重合未知。
          这些结果不代表本书准确率、专名或声音同步精度。
        </p>
        <p className="tools-hint">
          生成后可点击句子回听，用“纠错”保存文字修订。判断小说原文映射与声音边界时，应分别核对实际音频，无法确定的内容保留待检查。
        </p>
      </div>
    </details>
  )
}
