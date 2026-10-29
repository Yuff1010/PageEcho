import type { Result } from './contracts'
import type {
  TextSourceState,
  TextBrowseRequest,
  TextBrowsePage,
  TextDetailRequest,
  TextBookDetail,
  TextImportRequest,
  TextImportResult,
  RemoteLibraryConfig,
  RemoteLibraryInfo,
  RemoteManifestPreview,
} from './text-sources'

export const TEXT_SOURCE_CHANNELS = {
  state: 'text-sources:state',
  browse: 'text-sources:browse',
  detail: 'text-sources:detail',
  import: 'text-sources:import',
  cancel: 'text-sources:cancel',
  save: 'remote-libraries:save',
  remove: 'remote-libraries:remove',
  check: 'remote-libraries:check',
  manifestPreview: 'remote-libraries:manifest-preview',
  manifestApply: 'remote-libraries:manifest-apply',
  manifestExport: 'remote-libraries:manifest-export',
} as const

export interface TextSourceApi {
  textSources(): Promise<Result<TextSourceState>>
  textBrowse(request: TextBrowseRequest): Promise<Result<TextBrowsePage>>
  textDetail(request: TextDetailRequest): Promise<Result<TextBookDetail>>
  textImport(request: TextImportRequest): Promise<Result<TextImportResult>>
  textCancel(request: { requestId: string }): Promise<Result<void>>
  remoteLibrarySave(request: RemoteLibraryConfig): Promise<Result<RemoteLibraryInfo>>
  remoteLibraryRemove(request: { id: string }): Promise<Result<void>>
  remoteLibraryCheck(request: {
    requestId: string
    sourceId: string
  }): Promise<Result<RemoteLibraryInfo>>
  remoteManifestPreview(request: { rawJson: string }): Promise<Result<RemoteManifestPreview>>
  remoteManifestApply(request: { rawJson: string }): Promise<Result<TextSourceState>>
  remoteManifestExport(): Promise<Result<string>>
}
